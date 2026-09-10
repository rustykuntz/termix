const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('fs');
const http = require('http');
const { tmpdir } = require('os');
const { join, resolve } = require('path');
const WebSocket = require('ws');
const { HeadlessServer } = require('../src/server');
const { MAX_UPLOAD_BYTES } = require('../src/upload');

const CLI = resolve(__dirname, '../bin/clideck.js');

function waitFor(messages, predicate, timeoutMs = 3000) {
  return new Promise((resolveValue, reject) => {
    const started = Date.now();
    const poll = () => {
      const value = messages.find(predicate);
      if (value) resolveValue(value);
      else if (Date.now() - started >= timeoutMs) reject(new Error('event timeout'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

function startCli(args, env, cwd) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    result: new Promise((resolveResult) => {
      child.on('close', (code) => resolveResult({ code, stdout, stderr }));
    }),
  };
}

function putUrl(httpUrl, sessionId, name) {
  const url = new URL('/upload', httpUrl);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('name', name);
  return url;
}

function oversizedUpload(url) {
  return new Promise((resolveResult, reject) => {
    const request = http.request(url, {
      method: 'PUT',
      headers: { 'Content-Length': MAX_UPLOAD_BYTES + 1 },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveResult({
        status: response.statusCode,
        body: JSON.parse(body),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('real CLI prompt, annotate, and upload flows round-trip through the engine', async (context) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'clideck-inbound-'));
  const cwd = join(dataDir, 'project');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'canvas.png'), Buffer.from('image-body'));
  writeFileSync(join(cwd, 'notes.md'), '# not an image');
  const server = new HeadlessServer({ port: 0, dataDir, autoSaveMs: 0 });
  let socket;
  context.after(async () => {
    socket?.close();
    await server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const { httpUrl, url: wsUrl } = await server.listen();
  socket = new WebSocket(wsUrl);
  await new Promise((resolveOpen, reject) => {
    socket.once('open', resolveOpen);
    socket.once('error', reject);
  });
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data)));
  socket.send(JSON.stringify({
    type: 'session.create',
    provider: 'shell',
    name: 'Inbound',
    cwd,
    cols: 80,
    rows: 24,
  }));
  const created = await waitFor(
    messages,
    (event) => event.type === 'session.created' && event.name === 'Inbound',
  );
  const env = { CLIDECK_SESSION_ID: created.sessionId, CLIDECK_URL: httpUrl };

  const promptCli = startCli([
    'prompt',
    'Pick exactly',
    '--options',
    'Alpha, Beta,Gamma',
    '--timeout',
    '10m',
  ], env, cwd);
  const shown = await waitFor(
    messages,
    (event) => event.type === 'prompt.show' && event.question === 'Pick exactly',
  );
  assert.deepEqual(shown.options, ['Alpha', 'Beta', 'Gamma']);
  socket.send(JSON.stringify({
    type: 'prompt.answer',
    promptId: shown.promptId,
    value: 'Beta\nbyte-exact',
  }));
  assert.deepEqual(await promptCli.result, {
    code: 0,
    stdout: 'Beta\nbyte-exact',
    stderr: '',
  });
  await waitFor(
    messages,
    (event) => event.type === 'prompt.resolved' && event.promptId === shown.promptId,
  );

  const annotateCli = startCli(
    ['annotate', 'canvas.png', '--timeout', '10m'],
    env,
    cwd,
  );
  const annotation = await waitFor(
    messages,
    (event) => event.type === 'prompt.show' && event.annotate?.name === 'canvas.png',
  );
  const image = await fetch(`${httpUrl}${annotation.annotate.url}`);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(await image.text(), 'image-body');
  const marks = '{"marks":[{"x":1,"y":2}]}';
  socket.send(JSON.stringify({
    type: 'prompt.answer',
    promptId: annotation.promptId,
    value: marks,
  }));
  assert.deepEqual(await annotateCli.result, { code: 0, stdout: marks, stderr: '' });
  const nonImage = await startCli(
    ['annotate', 'notes.md', '--timeout', '10ms'],
    env,
    cwd,
  ).result;
  assert.equal(nonImage.code, 1);
  assert.match(nonImage.stderr, /requires an image/i);

  const firstUpload = await fetch(putUrl(httpUrl, created.sessionId, 'drop.txt'), {
    method: 'PUT',
    body: Buffer.from('first'),
  });
  assert.equal(firstUpload.status, 200);
  const first = await firstUpload.json();
  assert.equal(first.name, 'drop.txt');
  assert.equal(readFileSync(first.path, 'utf8'), 'first');
  const uploaded = await waitFor(
    messages,
    (event) => event.type === 'upload.done' && event.path === first.path,
  );
  assert.equal(uploaded.size, 5);

  const secondUpload = await fetch(putUrl(httpUrl, created.sessionId, 'drop.txt'), {
    method: 'PUT',
    body: Buffer.from('second'),
  });
  assert.equal(secondUpload.status, 200);
  const second = await secondUpload.json();
  assert.equal(second.name, 'drop-1.txt');
  assert.equal(readFileSync(second.path, 'utf8'), 'second');

  for (const name of ['..', '../escape', 'a/b', 'a\\b']) {
    const rejected = await fetch(putUrl(httpUrl, created.sessionId, name), {
      method: 'PUT',
      body: Buffer.from('x'),
    });
    assert.equal(rejected.status, 400, name);
    assert.equal((await rejected.json()).error, 'invalid_name');
  }
  const tooLarge = await oversizedUpload(
    putUrl(httpUrl, created.sessionId, 'large.bin'),
  );
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error, 'too_large');

  const timeoutCli = startCli(
    ['prompt', 'Let this timeout', '--timeout', '10ms'],
    env,
    cwd,
  );
  const timeoutShown = await waitFor(
    messages,
    (event) => event.type === 'prompt.show' && event.question === 'Let this timeout',
  );
  const timeoutResult = await timeoutCli.result;
  assert.equal(timeoutResult.code, 1);
  assert.equal(timeoutResult.stdout, '');
  assert.match(timeoutResult.stderr, /timed out/i);
  await waitFor(
    messages,
    (event) => event.type === 'prompt.resolved'
      && event.promptId === timeoutShown.promptId,
  );

  const closeCli = startCli(
    ['prompt', 'Close this session', '--timeout', '10m'],
    env,
    cwd,
  );
  const closeShown = await waitFor(
    messages,
    (event) => event.type === 'prompt.show' && event.question === 'Close this session',
  );
  socket.send(JSON.stringify({ type: 'session.close', sessionId: created.sessionId }));
  const closeResult = await closeCli.result;
  assert.equal(closeResult.code, 1);
  assert.match(closeResult.stderr, /session closed/i);
  await waitFor(
    messages,
    (event) => event.type === 'prompt.resolved'
      && event.promptId === closeShown.promptId,
  );
});
