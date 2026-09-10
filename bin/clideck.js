#!/usr/bin/env node

const { run } = require('../src/cli');

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
