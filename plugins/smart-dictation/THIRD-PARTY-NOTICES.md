# Third-party notices

Dictation downloads these pinned upstream assets on first use, rather than
redistributing their binaries or model weights in this repository:

- [NVIDIA NeMo-Speech.cpp](https://github.com/NVIDIA/NeMo-Speech.cpp), release
  **v0.1.0**, Apache License 2.0. Platform archives include upstream third-party
  license notices, retained in the private installation. SHA-256 pins for Mac
  Metal/CPU and Linux CPU archives are in `native-assets.js`.
- [NVIDIA Nemotron 3.5 ASR streaming 0.6B](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b),
  model revision `1c8deaecc64b91f034d73e08dd8b64625eb3395d`, under NVIDIA's
  Open Model License (OpenMDW 1.1). File:
  `nemotron-3.5-asr-streaming-0.6b.q8_0.gguf`, 741,548,352 bytes, SHA-256
  `a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae`.

Whisper and its Python dependencies are no longer downloaded or used by Dictation.
Existing installations' old cached files are not automatically deleted.
