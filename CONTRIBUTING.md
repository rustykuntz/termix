# Working on CliDeck

Keep changes simple and focused. Open an issue before starting a large change.

Use Node.js 22.12 or newer. Run `npm ci`, then `npm test`. Start the app with
`npm start -- --port 4200 --data-dir /tmp/clideck-dev` to keep development state
separate from your usual workspace. Run UI checks with
`node --test test-ui/*-it.mjs`. Native agent smoke scripts require the relevant
agent CLI and its account setup.

Include the problem, resulting behavior, and relevant checks in your pull request.
Test interface changes in both light and dark themes.
