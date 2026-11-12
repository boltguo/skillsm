#!/usr/bin/env node
import { main } from '../src/cli.js';

main().catch((error) => {
  if (error.name === 'ExitPromptError' || error.name === 'AbortPromptError') {
    console.error('\nCancelled.');
    process.exitCode = 130;
  } else {
    console.error(`skillsm: ${error.message}`);
    process.exitCode = 1;
  }
});
