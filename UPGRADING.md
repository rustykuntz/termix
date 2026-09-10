# Upgrading to CliDeck 2

CliDeck 2 replaces the legacy engine and interface. It keeps the npm package name
`clideck`, but uses **http://127.0.0.1:4100** and **`~/.clideck-next`** by default.
The separate directory avoids overwriting v1's incompatible session and settings
files in `~/.clideck`.

## Before updating

1. Finish or pause your agent work and stop the old CliDeck process yourself.
2. Keep a copy of `~/.clideck` and the agents' own conversation data.
3. Install Node.js 22.12 or newer, then run `npm install -g clideck@2`.
4. Run `clideck` and open the URL it prints.

Updating the npm package does not replace an already running process.

## Your workspace

V1 projects, saved prompts, command settings, plugins, and session entries are
**not imported automatically**. Create your projects and sessions in v2 and copy
the prompts or custom command settings you want to keep. Do not copy v1's
`sessions.json` or `config.json` into the v2 directory, or point `--data-dir` at
v1's directory: their formats differ.

Your agents' native conversation histories remain with their own CLIs. Use the
agent's own resume flow in a new v2 terminal to continue an older conversation.
CliDeck does not move or delete that native history.

If you already used the v2 development build, keep its `~/.clideck-next` directory;
the release continues using it. Explicit plugin settings are preserved.

V2 session backup and recovery are described in [SESSION-BACKUP.md](SESSION-BACKUP.md).

## Removed features

- **Autopilot:** sub-agents already cover this inside today's agent harnesses.
  CliDeck uses the CLI to let agents work with you and across providers instead.
- **Mobile control:** harnesses such as Codex and Claude Code provide remote
  access themselves. CliDeck no longer maintains a separate mobile control layer.
- **LAN binding:** v2 is localhost-only; `--host 0.0.0.0` is rejected.
- **Legacy plugins:** v2 has a new plugin SDK. It includes Emoji, Supertonic Voice,
  and Smart Dictation. OmniVoice is not available in this release.

Agent discovery and Ask remain available; use `clideck --help` for the v2 syntax.

## Going back to v1

Stop v2 yourself, then install `npm install -g clideck@1.33.1` and run `clideck`.
V1 continues using its original `~/.clideck` data and default port 4000.
V2 changes are stored separately and are not copied back into v1.
