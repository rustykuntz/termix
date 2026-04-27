const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');

// --- Self-update check (runs before server starts) ---
const currentVersion = require('./package.json').version;
const { execFile, execSync } = require('child_process');
const shellOpt = process.platform === 'win32';

function checkSelfUpdate() {
  return new Promise(ok => {
    // Skip in non-interactive or local dev contexts
    if (!process.stdin.isTTY || !process.stdout.isTTY) return ok();
    if (!__dirname.includes(join('node_modules', 'clideck'))) return ok();
    execFile('npm', ['view', 'clideck', 'version'], { shell: shellOpt, timeout: 10000 }, (err, stdout) => {
      if (err) return ok();
      const latest = stdout.trim();
      if (!latest || latest === currentVersion) return ok();
      const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n\x1b[38;5;105m  Update available:\x1b[0m \x1b[38;5;245m${currentVersion}\x1b[0m → \x1b[38;5;44m${latest}\x1b[0m\n\n  \x1b[38;5;252mUpdate now? [Y/n]\x1b[0m `, answer => {
        rl.close();
        if (answer.trim().toLowerCase() === 'n') return ok();
        console.log('\n  \x1b[38;5;245mUpdating...\x1b[0m\n');
        try {
          execSync('npm install -g clideck', { stdio: 'inherit', shell: true });
          console.log('\n  \x1b[38;5;44mUpdated to v' + latest + '. Restarting...\x1b[0m\n');
          const { spawn } = require('child_process');
          spawn(process.argv[0], process.argv.slice(1), { stdio: 'inherit', shell: shellOpt }).on('close', code => process.exit(code));
          return;
        } catch {
          console.log('\n  \x1b[38;5;196mUpdate failed.\x1b[0m Continuing with v' + currentVersion + '.\n');
          ok();
        }
      });
    });
  });
}

checkSelfUpdate().then(() => {

const { onConnection } = require('./handlers');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');
const plugins = require('./plugin-loader');

ensurePtyHelper();
sessions.loadSessions();
transcript.init(sessions.broadcast, new Set(sessions.getResumable().map(s => s.id)), (...args) => plugins.notifyTranscript(...args));
telemetry.init(sessions.broadcast, sessions.getSessions);
require('./opencode-bridge').init(sessions.broadcast, sessions.getSessions);
const config = require('./config');
plugins.init(sessions.broadcast, sessions.getSessions, () => require('./handlers').getConfig(), (cfg) => config.save(cfg), sessions.input, sessions.createProgrammatic, sessions.close);

const PORT = 4000;
const hostIdx = process.argv.indexOf('--host');
const hostArg = hostIdx >= 0 ? process.argv[hostIdx + 1] : undefined;
const HOST = hostIdx < 0 ? '127.0.0.1' : (hostArg && !hostArg.startsWith('-') ? hostArg : '0.0.0.0');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const ALIASES = {
  '/xterm.css':    require.resolve('@xterm/xterm/css/xterm.css'),
  '/xterm.js':     require.resolve('@xterm/xterm/lib/xterm.js'),
  '/addon-fit.js': require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');
const geminiMenuPoll = new Map();

function startGeminiMenuPoll(id) {
  const prev = geminiMenuPoll.get(id);
  if (prev) clearInterval(prev);
  const started = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - started > 3000) {
      clearInterval(timer);
      geminiMenuPoll.delete(id);
      return;
    }
    sessions.broadcast({ type: 'terminal.capture', id });
  }, 500);
  geminiMenuPoll.set(id, timer);
}

const server = http.createServer((req, res) => {
  // OTLP telemetry endpoint — receives JSON from CLI agents
  // Some agents (Gemini) POST to / instead of /v1/logs
  if (req.method === 'POST' && (req.url === '/v1/logs' || req.url === '/')) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1e6) { req.destroy(); return; }
    });
    req.on('end', () => {
      const contentType = req.headers['content-type'] || '';
      try { req.body = JSON.parse(body); } catch {
        console.log(`OTLP: failed to parse body (content-type: ${contentType}, ${body.length} bytes)`);
        req.body = null;
      }
      telemetry.handleLogs(req, res);
    });
    return;
  }

  // Codex notify hook endpoint — deterministic turn-complete signal
  if (req.method === 'POST' && req.url === '/hook/codex/stop') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const clideckId = payload.clideck_id;
        const threadId = payload['thread-id'] || payload.session_id;
        // console.log(`[codex] notify clideck=${clideckId ? clideckId.slice(0,8) : 'none'} thread=${threadId ? threadId.slice(0,8) : 'none'}`);
        const allSessions = sessions.getSessions();
        let matched = false;
        if (clideckId && allSessions.has(clideckId)) {
          matched = true;
          // console.log(`[codex] notify matched by clideck_id session=${clideckId.slice(0,8)}`);
          require('./telemetry-receiver').armCodexStop(clideckId);
        } else if (threadId) {
          for (const [id, s] of allSessions) {
            if (s.sessionToken === threadId) {
              matched = true;
              // console.log(`[codex] notify matched by thread session=${id.slice(0,8)} thread=${threadId.slice(0,8)}`);
              require('./telemetry-receiver').armCodexStop(id);
              break;
            }
          }
        }
        // if (!matched) console.log(`[codex] notify no match clideck=${clideckId ? clideckId.slice(0,8) : 'none'} thread=${threadId ? threadId.slice(0,8) : 'none'}`);
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Claude Code hook endpoints — deterministic start/stop/idle signals
  if (req.method === 'POST' && req.url.startsWith('/hook/claude/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/claude/'.length);
        const sessionId = payload.session_id;
        const allSessions = sessions.getSessions();
        const clideckId = payload.clideck_id && allSessions.has(payload.clideck_id)
          ? payload.clideck_id
          : sessionId
            ? [...allSessions].find(([, s]) => s.sessionToken === sessionId)?.[0]
            : null;
        // console.log(`[claude] hook ${route} clideck=${payload.clideck_id?.slice(0,8) || 'none'} session=${sessionId?.slice(0,8) || 'none'} match=${clideckId?.slice(0,8) || 'none'}`);
        if (clideckId) {
          const sess = allSessions.get(clideckId);
          if (route === 'start') {
            // console.log(`[claude] status working=true source=hook session=${clideckId.slice(0,8)}`);
            sessions.broadcast({ type: 'session.status', id: clideckId, working: true, source: 'hook' });
          } else if (route === 'stop' || route === 'idle') {
            // console.log(`[claude] status working=false source=hook session=${clideckId.slice(0,8)}`);
            sessions.broadcast({ type: 'session.status', id: clideckId, working: false, source: 'hook' });
            // After an approval menu, Claude can already be idle before the real
            // stop hook arrives. In that case there is no new working→idle edge
            // on the client, so force one final capture from the true stop signal.
            if (route === 'stop' && sess && !sess.working) {
              // console.log(`[claude] stop capture session=${clideckId.slice(0,8)} source=claude-stop`);
              setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId }), 500);
            }
          } else if (route === 'menu') {
            // PreToolUse: trigger terminal capture — detectMenu will set idle if a choice menu is visible
            const menuVersion = sess ? ((sess._menuVersion || 0) + 1) : 1;
            if (sess) sess._menuVersion = menuVersion;
            // console.log(`[claude] menu capture session=${clideckId.slice(0,8)} source=claude-menu version=${menuVersion}`);
            setTimeout(() => sessions.broadcast({ type: 'terminal.capture', id: clideckId, menuVersion }), 500);
          }
        } else {
          // console.log(`[claude] hook ${route} no-match`);
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // Gemini hook endpoints — deterministic start/stop/menu signals
  if (req.method === 'POST' && req.url.startsWith('/hook/gemini/')) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const route = req.url.slice('/hook/gemini/'.length);
        const allSessions = sessions.getSessions();
        const clideckId = payload.clideck_id && allSessions.has(payload.clideck_id)
          ? payload.clideck_id
          : [...allSessions].find(([, s]) => s.sessionToken === payload.session_id)?.[0];
        if (clideckId) {
          const s = allSessions.get(clideckId);
          if (s && payload.session_id && !s.sessionToken) s.sessionToken = payload.session_id;
          if (route === 'menu') {
            startGeminiMenuPoll(clideckId);
          } else {
            sessions.broadcast({ type: 'session.status', id: clideckId, working: route === 'start', source: 'hook' });
          }
        }
      } catch {}
      res.writeHead(200).end('{}');
    });
    return;
  }

  // OpenCode plugin bridge events
  if (req.method === 'POST' && req.url === '/opencode-events') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { require('./opencode-bridge').handleEvent(JSON.parse(body)); } catch (e) { console.error('[opencode-bridge] handleEvent error:', e); }
      res.writeHead(200).end('{}');
    });
    return;
  }

  // DEBUG: log any POST (agents might use /v1/traces, /v1/metrics, or other paths)
  if (req.method === 'POST') {
    // console.log(`OTLP: received POST ${req.url} (not handled)`);
    return res.writeHead(200).end('{}');
  }

  // Plugin static files (/plugins/<id>/client.js, /plugins/<id>/public/*)
  if (req.url.startsWith('/plugins/')) {
    const pluginFile = plugins.resolveFile(req.url);
    if (pluginFile) {
      res.writeHead(200, { 'Content-Type': MIME[extname(pluginFile)] || 'application/javascript' });
      return res.end(readFileSync(pluginFile));
    }
    return res.writeHead(404).end();
  }

  const filePath = ALIASES[req.url]
    || resolve(PUBLIC_ROOT, (req.url === '/' ? 'index.html' : req.url).replace(/^\//, ''));
  if (!filePath.startsWith(PUBLIC_ROOT) && !ALIASES[req.url]) return res.writeHead(403).end();
  if (!existsSync(filePath)) return res.writeHead(404).end();
  try {
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(readFileSync(filePath));
  } catch { res.writeHead(500).end(); }
});

const allowedOrigins = new Set([
  `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`,
  `http://[::1]:${PORT}`, `http://${HOST}:${PORT}`,
  `https://localhost:${PORT}`, `https://127.0.0.1:${PORT}`,
  `https://[::1]:${PORT}`, `https://${HOST}:${PORT}`,
  `https://${HOST}`,
]);
const wss = new WebSocketServer({
  server,
  verifyClient: ({ req }) => {
    const origin = req.headers.origin;
    if (!origin) return true;            // non-browser clients (curl, etc.)
    return allowedOrigins.has(origin);
  },
});
wss.on('connection', onConnection);

const activity = require('./activity');
activity.start(sessions.getSessions(), sessions.broadcast);
sessions.startAutoSave(() => require('./handlers').getConfig());

// Graceful shutdown: persist sessions before exit
const { getConfig } = require('./handlers');
function onShutdown() {
  plugins.shutdown();
  activity.stop();
  sessions.shutdown(getConfig());
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

server.listen(PORT, HOST, () => {
  const v = require('./package.json').version;
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.log(`
\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;239m   ██████╗\x1b[38;5;242m██╗     \x1b[38;5;245m██╗\x1b[38;5;105m██████╗ \x1b[38;5;141m███████╗\x1b[38;5;147m ██████╗\x1b[38;5;183m██╗  ██╗\x1b[0m
\x1b[38;5;239m  ██╔════╝\x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██╔══██╗\x1b[38;5;141m██╔════╝\x1b[38;5;147m██╔════╝\x1b[38;5;183m██║ ██╔╝\x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m█████╗  \x1b[38;5;147m██║     \x1b[38;5;183m█████╔╝ \x1b[0m
\x1b[38;5;239m  ██║     \x1b[38;5;242m██║     \x1b[38;5;245m██║\x1b[38;5;105m██║  ██║\x1b[38;5;141m██╔══╝  \x1b[38;5;147m██║     \x1b[38;5;183m██╔═██╗ \x1b[0m
\x1b[38;5;239m  ╚██████╗\x1b[38;5;242m███████╗\x1b[38;5;245m██║\x1b[38;5;105m██████╔╝\x1b[38;5;141m███████╗\x1b[38;5;147m╚██████╗\x1b[38;5;183m██║  ██╗\x1b[0m
\x1b[38;5;239m   ╚═════╝\x1b[38;5;242m╚══════╝\x1b[38;5;245m╚═╝\x1b[38;5;105m╚═════╝ \x1b[38;5;141m╚══════╝\x1b[38;5;147m ╚═════╝\x1b[38;5;183m╚═╝  ╚═╝\x1b[0m

\x1b[38;5;105m  ╺━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸\x1b[0m

\x1b[38;5;245m  v${v}\x1b[0m

\x1b[38;5;252m  ▸ Ready at \x1b[38;5;44m${url}\x1b[0m
\x1b[38;5;245m  ▸ Stop with \x1b[38;5;252mCtrl+C\x1b[38;5;245m · Restart anytime with \x1b[38;5;252mclideck\x1b[0m
${HOST !== '127.0.0.1' ? '\x1b[38;5;208m  ▸ Warning: listening on ' + HOST + ' — no authentication, anyone on the network can connect\x1b[0m\n' : ''}`);
});

}); // checkSelfUpdate
