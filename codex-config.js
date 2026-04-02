function normalizeCodexToml(content) {
  return String(content || '')
    .replace(/\r\n/g, '\n')
    .replace(/([^\n])(\[(?:projects|notice|plugins)\.[^\n]*\])/g, '$1\n$2')
    .replace(/([^\n])(\[(?:features|otel)\])/g, '$1\n$2')
    .replace(/([^\n])(\[\[skills\.[^\n]*\]\])/g, '$1\n$2');
}

function splitTomlSections(content) {
  const lines = normalizeCodexToml(content).split('\n');
  const top = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      current = { header: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else top.push(line);
  }
  return { top, sections };
}

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function upsertCodexConfig(content, nodePath, notifyHelperPath, codexHookEnabled, port) {
  const { top, sections } = splitTomlSections(content);
  const notifyLine = `notify = ["${nodePath}", "${notifyHelperPath}", "${port}"]`;
  const cleanedTop = top.filter(line => !/^\s*notify\s*=/.test(line));
  const topOut = trimBlankEdges([...cleanedTop, notifyLine]);
  sections.forEach(section => {
    section.lines = section.lines.filter(line => !/^\s*notify\s*=/.test(line));
  });

  let features = sections.find(s => s.header === '[features]');
  if (!features) {
    features = { header: '[features]', lines: [] };
    sections.push(features);
  }
  features.lines = trimBlankEdges([
    ...features.lines.filter(line => !/^\s*codex_hooks\s*=/.test(line)),
    `codex_hooks = ${codexHookEnabled ? 'true' : 'false'}`,
  ]);

  const otelHeader = '[otel]';
  const otelBody = [`exporter = { otlp-http = { endpoint = "http://localhost:${port}", protocol = "json" } }`];
  const withoutOtel = sections.filter(s => s.header !== otelHeader);
  withoutOtel.push({ header: otelHeader, lines: otelBody });

  const out = [];
  if (topOut.length) out.push(...topOut, '');
  withoutOtel.forEach((section, idx) => {
    out.push(section.header, ...trimBlankEdges(section.lines));
    if (idx < withoutOtel.length - 1) out.push('');
  });
  return out.join('\n').trimEnd() + '\n';
}

function validateCodexConfigToml(content) {
  const lines = normalizeCodexToml(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^\[\[.*\]\]$/.test(t) || /^\[.*\]$/.test(t)) continue;
    if (!t.includes('=')) return { ok: false, error: `Invalid TOML line ${i + 1}: ${t}` };
    if (/(?:^|[^\s=])\[(?:projects|notice|plugins)\.|(?:^|[^\s=])\[(?:features|otel)\]|(?:^|[^\s=])\[\[skills\./.test(t)) {
      return { ok: false, error: `Glued TOML headers on line ${i + 1}` };
    }
  }
  return { ok: true };
}

module.exports = { upsertCodexConfig, validateCodexConfigToml };
