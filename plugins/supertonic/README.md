# Supertonic Voice for CliDeck

This bundled plugin reads agent replies or selected text with Supertonic 3. Inference runs locally inside the isolated plugin worker; no text is sent to a speech API.

Enabled by default, with **Female 2**, **F5** for reading the selection, **English**,
**12 quality steps**, and **English technical** text normalization. Automatic reading
of completed replies is **off**. Existing saved choices are retained.

The immutable Supertonic model and ONNX WebAssembly runtime download on first use (about 400 MB combined). CliDeck stores the model in the browser cache for later sessions. WebGPU is preferred, with a WASM fallback. Choose between Female 1, Female 2, Yara, Mike, and Dov, preview them, or set a conflict-safe selection shortcut in Settings > Plugins > Supertonic Voice. Repeating the shortcut for the same text pauses or resumes the cached clip; changed text is synthesized once. English technical normalization programmatically expands numbers, money, dates, time, decimals, and ordinals before applying the vocabulary lexicon.

Supertonic supports **Mac and Ubuntu** through the same browser runtime. Use a
current Chrome/Chromium browser; if WebGPU is unavailable (including on Ubuntu),
it retries on the CPU through WebAssembly. No CUDA, NVIDIA graphics card, Python,
or Mac-only native helper is required. First use needs internet access for the
runtime and model downloads. Synthesis happens on the computer running the browser,
even when the CliDeck server runs elsewhere. CPU speed depends on that computer.

English normalization describes recognized file paths by their extension: documents,
photos, videos, audio, spreadsheets, presentations, archives, code and data files.
For example, `docs/report.md` becomes “the document path is in our conversation”;
`images/photo.jpg` becomes “the photo path is in our conversation”. Unknown types
use “the file path is in our conversation”. URLs keep “the URL in our conversation”.
Paths still require a directory and a file extension (or dotfile); bare filenames
and extensionless paths stay literal. Turning normalization off disables these replacements.

Read-along uses an estimated three-word window that advances one source word at a time. Estimates
are weighted by normalized speech (so `365` gets the time of "three hundred sixty five") and reset at each
generated audio chunk. They are a reading guide, not measured word timestamps. Source spans survive number,
date, acronym, URL and file-path replacements; language-aware segmentation handles text without spaces.
The host follows the audio clock and owns the terminal highlight. Selection anchors identify the selected
occurrence when the same text appears more than once. Terminal rendering differences or unavailable source
text can still leave a window unhighlighted; playback continues.

Long readings play in bounded batches (up to 1,200 source characters), preparing only the next batch while
the current one plays. Stop cancels the remaining reading, including during preparation between batches.
The player seeks within the current batch, not across the entire document. Short readings retain their
replay cache; long readings do not retain all generated audio. There is no reader-specific 8,000-character
limit; the existing document, plugin-message and per-clip audio safety limits still apply.

Headings and paragraph boundaries retain blank lines in the extracted text. Generated speech is preserved;
estimated read-along positions never insert silence into it, since an estimate can land inside a word.
The existing 300 ms pauses between generated chunks remain. Coarse model-sized chunks still apply to
long text, including long unpunctuated passages.

Agents can request speech with:

```bash
clideck supertonic/speak "Read this aloud"
```

Supertonic sample code is MIT licensed. The model is OpenRAIL-M licensed. Upstream announced that its repository will be archived after July 2026, so this integration pins the last published Supertonic 3 model revision rather than tracking a moving endpoint. See `THIRD-PARTY-NOTICES.md`.

Additional voice profiles are trained locally with the recovered community cloner. See [VOICE-CLONING.md](VOICE-CLONING.md) for preparation, training, preview, and import steps.
