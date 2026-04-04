<p align="center">
  <img src="public/img/clideck-logo-icon.png" width="64" alt="clideck logo">
</p>

<h1 align="center">clideck</h1>

<p align="center">
  one screen for AI coding agents.
  <br><br>
  <a href="https://clideck.dev">Website</a> · <a href="https://docs.clideck.dev">Docs</a> · <a href="https://youtu.be/hICrtjGAeDk">Demo</a> · <a href="https://www.npmjs.com/package/clideck"><img src="https://img.shields.io/npm/v/clideck" alt="npm version"></a>
</p>

<!-- TODO: Replace with a ~10 second GIF showing: open clideck,
     sidebar with multiple agents across projects, click between them,
     one working one idle. No narration needed. -->

<p align="center">
  <img src="assets/clideck-themes.jpg" width="720" alt="clideck dashboard">
</p>

clideck is a local app for running multiple AI coding agents without juggling terminals. Claude Code, Codex, Gemini CLI, and OpenCode all live in one browser window with a chat-style sidebar, live status, message previews, session resume, and projects to keep things organized. an autopilot routes work between agents automatically, and an E2E encrypted mobile relay gives full control over all agents from a phone.

the main problem with using multiple agents is not starting them. it is managing them. terminals pile up, finished work gets missed, good sessions disappear after a restart. clideck does not sit in the middle rewriting prompts or output - it only watches lightweight status signals (OpenTelemetry) so it can tell which agent is working, which is idle, and which is waiting. everything runs locally, no data leaves your machine.

## Why this exists

Terminal multiplexers are great at panes. clideck is about conversations.

A pane grid is flat. agent work usually is not. projects, roles, previews, timestamps, notifications, resume, and sometimes a bit of routing between specialists all fit more naturally into a chat app layout. it also maps naturally to mobile, so the same mental model works on desktop and phone.

## Quick start

```bash
npm install -g clideck
clideck
```

Open [localhost:4000](http://localhost:4000). Click **+**, pick an agent, start working.

Or just run it once with `npx clideck`. Works on macOS and Windows. Node 18+. Linux: untested - if you try it, [open an issue](https://github.com/rustykuntz/clideck/issues).

## What makes it useful

**Live status** - see which agent is working and which is waiting. Status detection for Claude Code, Codex, Gemini CLI, and OpenCode.

**Session resume** - close the lid, reopen tomorrow, pick up where things left off. each agent's session ID is captured automatically.

**Roles** - give agents reusable identities like programmer, reviewer, or product manager. prompts are injected automatically when a session starts.

**Autopilot** - enable autopilot on a project, walk away. it watches for one agent to finish, hands the output to the next one, and keeps going until the work is done or blocked. this is the part that makes sleep possible. routes content verbatim, no rewriting or summarizing. fingerprints each output and tracks handoff history to guard against repeat loops. ~50 output tokens per routing decision. supports Anthropic, OpenAI, Google, Groq, xAI, Mistral, OpenRouter, Cerebras.

<p align="center">
  <img src="assets/autopilot.gif" width="720" alt="Autopilot routing work between agents">
</p>

**Mobile remote** - the agents keep running on the local machine. status, prompts, history, and replies stay available from a phone while away. E2E encrypted, no account needed.

**Native terminals** - each session opens into its real terminal. keys go straight to the agent, nothing sits in the middle.

## Supported agents

Claude Code, Codex, Gemini CLI, OpenCode, Shell, and any other terminal tool.

## Also

- **Projects** - group sessions, drag and drop
- **Prompt library** - save reusable prompts, type `//` to paste
- **Search** - find sessions or scroll through transcripts
- **Plugins** - server + client API. ships with Voice Input, Trim Clip, and Autopilot. build your own
- **15 themes** - dark, light, or make your own
- **Notifications** - browser + sound alerts when agents finish

## Docs

Guides, agent setup, plugin development: **[docs.clideck.dev](https://docs.clideck.dev)**

## Acknowledgments

Built with [xterm.js](https://xtermjs.org/).

## License

MIT - see [LICENSE](LICENSE).
