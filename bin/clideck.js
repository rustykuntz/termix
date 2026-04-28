#!/usr/bin/env node
const args = process.argv.slice(2);

if (args[0] === 'ask') {
  require('../clideck-ask-cli').run(args.slice(1));
} else {
  require('../server.js');
}
