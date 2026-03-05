const http = require('http');
const { readFileSync, existsSync } = require('fs');
const { join, extname, resolve } = require('path');
const { WebSocketServer } = require('ws');
const { ensurePtyHelper } = require('./utils');
const { onConnection } = require('./handlers');
const sessions = require('./sessions');

const transcript = require('./transcript');
const telemetry = require('./telemetry-receiver');

ensurePtyHelper();
sessions.loadSessions();
transcript.init(sessions.broadcast);
telemetry.init(sessions.broadcast, sessions.getSessions);

const PORT = 4000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };
const ALIASES = {
  '/xterm.css':    join(__dirname, 'node_modules/xterm/css/xterm.css'),
  '/xterm.js':     join(__dirname, 'node_modules/xterm/lib/xterm.js'),
  '/addon-fit.js': join(__dirname, 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js'),
};

const PUBLIC_ROOT = join(__dirname, 'public');

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

  // DEBUG: log any POST (agents might use /v1/traces, /v1/metrics, or other paths)
  if (req.method === 'POST') {
    console.log(`OTLP: received POST ${req.url} (not handled)`);
    return res.writeHead(200).end('{}');
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

const wss = new WebSocketServer({ server });
wss.on('connection', onConnection);

// TEMPORARY: stats overlay
const stats = require('./stats');
stats.start(sessions.getSessions(), sessions.broadcast);

// Graceful shutdown: persist sessions before exit
const { getConfig } = require('./handlers');
function onShutdown() {
  stats.stop();
  sessions.shutdown(getConfig());
  process.exit(0);
}
process.on('SIGINT', onShutdown);
process.on('SIGTERM', onShutdown);

server.listen(PORT, '127.0.0.1', () => console.log(`Terminal UI → http://localhost:${PORT}`));
