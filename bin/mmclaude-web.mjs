#!/usr/bin/env node
/** Clean web-page reader used by the default defuddle skill. */
import { spawnSync } from 'node:child_process';
import { findExecutable } from './mmclaude-integrations.mjs';

const WIN = process.platform === 'win32';
const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//i.test(a));
if (!url) {
  console.error('Usage: mmclaude web <https://url> [--json]');
  process.exit(2);
}

function runDefuddle(command) {
  const defuddleArgs = ['parse', url, args.includes('--json') ? '--json' : '--md'];
  if (!WIN) return spawnSync(command, defuddleArgs, { stdio: 'inherit' }).status ?? 1;
  const quote = value => /[\s"&|<>^]/.test(value) ? `"${String(value).replace(/"/g, '""')}"` : String(value);
  return spawnSync([command, ...defuddleArgs].map(quote).join(' '), [], { stdio: 'inherit', shell: true }).status ?? 1;
}

const defuddle = findExecutable('defuddle');
if (defuddle) process.exit(runDefuddle(defuddle));

// Agent Reach uses Jina Reader as its zero-configuration web backend. It is a safe fallback
// until the user chooses to install the Defuddle CLI; this keeps webpage requests useful on a
// fresh shim without downloading an npm package during setup.
try {
  const target = `https://r.jina.ai/${url}`;
  const response = await fetch(target, { signal: AbortSignal.timeout(30000), headers: { accept: 'text/plain' } });
  if (!response.ok) throw new Error(`clean reader returned HTTP ${response.status}`);
  console.error('mmclaude web: Defuddle is not installed; using Agent Reach/Jina clean-reader fallback. Install with: npm install -g defuddle');
  process.stdout.write(await response.text());
  process.exit(0);
} catch (error) {
  console.error(`mmclaude web: ${error.message}`);
  process.exit(1);
}
