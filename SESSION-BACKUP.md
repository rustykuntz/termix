# Session backup and recovery

Settings → General → Session management downloads a dated JSON file containing
CliDeck's current session registry and project definitions. It includes session
names, working directories and native resume references, including dormant sessions.

This is a same-machine session-reference backup, not a complete machine backup.
It does not include native Codex/Claude/other agent histories, CliDeck transcripts,
terminal scrollback, viewer files, custom command definitions, or credentials.
Keep the native agent data and working directories to resume conversations.

## Automatic recovery

CliDeck writes `sessions.json` atomically and keeps its previous valid snapshot as
`sessions.backup.json` in its data directory (normally `~/.clideck-next`). The first
save seeds both copies. If the registry is missing or invalid, startup uses a valid
recovery copy and retains the invalid file as `sessions.json.corrupt-<timestamp>`.

If neither copy is usable, startup stops with a recovery message. It does not start
with an empty registry and overwrite the saved state. Startup also preserves
unrecognized transcript and viewer-payload files, since they may be newer than the
recovered registry. Explicit session/content deletion still removes its own data.

## Restoring a downloaded backup

There is no in-app import in this version. To restore manually:

1. Stop the CliDeck engine. Preserve a copy of its current data directory first.
2. Check that the downloaded file has `format: "clideck-session-backup"` and
   `version: 1`. Save its `sessions` array as `sessions.json` in the data directory.
3. To restore project grouping, merge the backup's `projects` array into the
   `projects` field of `config.json`. Preserve the other configuration fields.
4. Restart CliDeck. Recovered sessions appear dormant; resume the ones you need.

Copying only these files to another computer does not copy the native conversations
or projects they refer to. For custom-command sessions, retain their command settings
as well. Avoid importing registry entries into a running engine: it owns the current
state and will save over external edits.
