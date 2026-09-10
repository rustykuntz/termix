const { createHash, randomUUID } = require('crypto');
const { createReadStream, createWriteStream } = require('fs');
const { mkdir, stat, rename, rm } = require('fs/promises');
const { join } = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { execFile } = require('child_process');
const { promisify } = require('util');

const VERSION = '0.1.0';
const MODEL = {
  file: 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf',
  revision: '1c8deaecc64b91f034d73e08dd8b64625eb3395d',
  sha256: 'a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae',
  bytes: 741548352,
};
const BUILDS = {
  'macos-aarch64-metal': 'f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244',
  'macos-aarch64-cpu': '971661d38d4bf97a63c528d13041a964316d25068d8df045e5b4839848092f25',
  'macos-x86_64-cpu': '042a4612e07460fab6a39b5d862aa1e39d0ac3eaedfdb979f3f5fc12de510c20',
  'linux-x86_64-cpu': '0f74131d631ad2c694cf0ec53490866bb6461147959589a69fb6fc231944065b',
  'linux-aarch64-cpu': '0e4112255d566de7bdd142f239e984995c4447103ba8feb41f2bb5c559d561d3',
};

function selectBuild(device = 'auto', platform = process.platform, arch = process.arch) {
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('Dictation supports Mac and Ubuntu on Apple Silicon, Intel/AMD or ARM64.');
  }
  const metal = platform === 'darwin' && arch === 'arm64' && device !== 'cpu';
  if (device === 'mps' && !metal) throw new Error('Apple Metal requires an Apple Silicon Mac. Choose Automatic or CPU.');
  const key = `${platform === 'darwin' ? 'macos' : 'linux'}-${arch === 'arm64' ? 'aarch64' : 'x86_64'}-${metal ? 'metal' : 'cpu'}`;
  return { key, metal, sha256: BUILDS[key], file: `nemo-speech-${VERSION}-${key}.tar.gz` };
}

async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function download(url, path, expected, { signal, onProgress = () => {}, bytes } = {}) {
  try {
    if ((!bytes || (await stat(path)).size === bytes) && await checksum(path) === expected) return;
  } catch {}
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}). Try again.`);
    const hash = createHash('sha256');
    let received = 0;
    let lastPercent = -10;
    const total = bytes || Number(response.headers.get('content-length'));
    await pipeline(response.body, new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (bytes && received > bytes) return callback(new Error('Model download exceeds its expected size.'));
        hash.update(chunk);
        const percent = total ? Math.floor(received * 100 / total) : 0;
        if (percent >= lastPercent + 5) { lastPercent = percent; onProgress(percent); }
        callback(null, chunk);
      },
    }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    if ((bytes && received !== bytes) || hash.digest('hex') !== expected) {
      throw new Error('Downloaded speech files failed verification. Try again.');
    }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function ensureAssets(dataDir, device, signal, onStatus = () => {}) {
  const build = selectBuild(device);
  const root = join(dataDir, 'runtime', 'nemotron');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const installDir = join(root, `${VERSION}-${build.key}`);
  const binary = join(installDir, 'nemo-speech', 'bin', 'nemo-speech');
  try { await stat(binary); } catch {
    const archive = join(root, build.file);
    await download(`https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v${VERSION}/${build.file}`,
      archive, build.sha256, { signal, onProgress: (n) => onStatus(`Downloading speech runtime… ${n}%`) });
    const staging = `${installDir}.${randomUUID()}.tmp`;
    try {
      await mkdir(staging);
      await promisify(execFile)('tar', ['-xzf', archive, '-C', staging], { signal, timeout: 60_000 });
      signal.throwIfAborted();
      await rename(staging, installDir);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const model = join(root, MODEL.file);
  onStatus('Checking the local speech model…');
  await download(`https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b/resolve/${MODEL.revision}/${MODEL.file}`,
    model, MODEL.sha256, { signal, bytes: MODEL.bytes, onProgress: (n) => onStatus(`Downloading speech model (742 MB, first use)… ${n}%`) });
  return { binary, model, metal: build.metal };
}

module.exports = { selectBuild, ensureAssets, download, checksum, MODEL, BUILDS };
