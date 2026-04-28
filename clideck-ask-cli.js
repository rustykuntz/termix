const http = require('http');
const https = require('https');

function usage() {
  return [
    'Usage:',
    '  clideck ask --session <name-or-id> --message <text> [--timeout 10m]',
    '  clideck ask <name-or-id> <message> [--timeout 10m]',
  ].join('\n');
}

function parseDuration(value) {
  if (!value) return 10 * 60 * 1000;
  const m = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] || 'ms').toLowerCase();
  const scale = unit === 'h' ? 3600000 : unit === 'm' ? 60000 : unit === 's' ? 1000 : 1;
  return Math.max(1, Math.round(n * scale));
}

function parseArgs(args) {
  const out = { timeoutMs: 10 * 60 * 1000, url: process.env.CLIDECK_URL || 'http://127.0.0.1:4000' };
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--session' || arg === '-s') out.session = args[++i];
    else if (arg === '--message' || arg === '-m') out.message = args[++i];
    else if (arg === '--timeout' || arg === '-t') {
      const parsed = parseDuration(args[++i]);
      if (!parsed) throw new Error('Invalid timeout value');
      out.timeoutMs = parsed;
    } else if (arg === '--url') out.url = args[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else positional.push(arg);
  }
  if (!out.session && positional.length) out.session = positional.shift();
  if (!out.message && positional.length) out.message = positional.join(' ');
  return out;
}

function readStdinIfAvailable() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/session/ask', url);
    const body = JSON.stringify(payload);
    const client = target.protocol === 'https:' ? https : http;
    const req = client.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs + 5000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch {}
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `CliDeck ask failed (${res.statusCode})`);
          err.statusCode = res.statusCode;
          return reject(err);
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('CliDeck ask timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

async function run(args) {
  try {
    const opts = parseArgs(args);
    if (opts.help) {
      console.log(usage());
      return;
    }
    if (!opts.message) opts.message = (await readStdinIfAvailable()).trim();
    if (!opts.session || !opts.message) throw new Error(usage());
    const callerSessionId = process.env.CLIDECK_SESSION_ID || '';
    if (!callerSessionId) throw new Error('CLIDECK_SESSION_ID is missing. Run this from inside a CliDeck session.');

    const res = await postJson(opts.url, {
      callerSessionId,
      target: opts.session,
      message: opts.message,
      timeoutMs: opts.timeoutMs,
    }, opts.timeoutMs);
    process.stdout.write((res.response || '').trimEnd() + '\n');
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { run, parseArgs, parseDuration };
