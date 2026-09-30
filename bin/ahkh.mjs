#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; setTimeout(() => process.exit(code), 50).unref?.(); },
  (e) => { console.error(e?.stack || e); process.exit(70); },
);
