# Dictation

Private streaming English dictation for CliDeck, using
[Nemotron 3.5 ASR streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b)
through NVIDIA's [NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp) native runtime.

Disabled by default. Enable the plugin, then press **F4** or click its microphone action. Words appear
in the dictation draft as you speak; final recognition can correct the partial
text. Press the shortcut again to stop and paste the completed text into the
original terminal without sending it. Change the shortcut in Settings → Plugins
→ Dictation. The microphone stays off until you activate dictation.

Everything spoken is text, including “send message”, “cancel recording”, and
“new paragraph”. There are no voice commands or background command listening.
The draft's **Cancel** button discards it, **Stop** pastes without sending, and
**Send** submits it. Stop and Send drain the final microphone frame and recognition
results before pasting. Cancel discards pending results too. Errors stop capture
and preserve the visible draft, which can still be pasted or discarded.

## Mac and Ubuntu

- Apple Silicon Mac: Metal by default; CPU can also be selected.
- Intel Mac: CPU.
- Ubuntu 20.04 or newer, x86-64 or ARM64: CPU. No NVIDIA graphics card required.
- Use a current browser with microphone and AudioWorklet support, such as Chrome
  or Chromium. Browser microphone access requires localhost or HTTPS and permission.
  If the browser is on another machine, recognition runs on the CliDeck server.

First use downloads the pinned native runtime and a **742 MB Q8 model**, checking
SHA-256 before installation. No Python, PyTorch, NeMo Python package, CUDA, or
system-wide installation is required. Internet access is needed for those first
use downloads; later transcription runs locally. Model files live under
`plugin-data/smart-dictation/runtime/nemotron` in CliDeck's data directory.

The runtime starts only on activation, listens on a random loopback port with a
per-process access token, and stays warm until plugin shutdown or a processor
change. Audio is mono PCM16 at 16 kHz, streamed in small frames. Recognition uses
320 ms model context and silence endpointing; there is no client-side pause gate.
Actual latency and transcription quality depend on the computer and recording.
Each dictation is bounded to five minutes and 16,000 characters; a disconnected
microphone or failed final response times out instead of leaving capture running.

The internal plugin ID remains `smart-dictation` to preserve enabled state and
saved shortcuts. Old Whisper/Granite downloads are left untouched, but are no
longer used. Restart CliDeck and refresh the browser after upgrading this plugin.

Validation includes native Metal and CPU streaming on Apple Silicon and automated
Mac/Linux build selection checks. Actual Ubuntu hardware performance has not yet
been measured. Supertonic's separate browser runtime is described in its README.
See `THIRD-PARTY-NOTICES.md` for exact revisions and licenses.
