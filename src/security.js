const { isIP } = require('net');

function isAllowedWebSocketOrigin(origin, host, bindHost) {
  if (!origin) return true;
  if (typeof origin !== 'string' || typeof host !== 'string' || !host.trim()) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.host.toLowerCase() === host.trim().toLowerCase()
      && (!isLoopbackHost(bindHost) || isLoopbackHost(parsed.hostname));
  } catch {
    return false;
  }
}

function isLoopbackHost(host) {
  const value = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  return isIP(value) === 4 && value.startsWith('127.');
}

function isLoopbackAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return value === '::1' || value === '127.0.0.1'
    || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

module.exports = { isAllowedWebSocketOrigin, isLoopbackAddress, isLoopbackHost };
