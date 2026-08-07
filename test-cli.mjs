#!/usr/bin/env node
/**
 * Tests for bin/dsv4f-lib.mjs — the small helper layer exported for testability.
 *
 * Currently covers resolveClaude(): the Windows PATH-resolver that picks between
 * 'claude' (no extension, lets cmd.exe apply PATHEXT) and an absolute fallback path.
 * The current dsv4f.mjs hardcodes the literal string 'claude.cmd' and never falls
 * back, which is the bug these tests will fail against.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { resolveClaude } from './bin/dsv4f-lib.mjs';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  catch (e) { console.log(`  \x1b[31m✗\x1b[0m ${name}  -> ${e.message}`); fail++; }
}

// All four test cases inject stubs via the dependency-injection signature, so the
// suite is identical on Linux, macOS and Windows.
const okWhere = { status: 0, stdout: Buffer.from('C:\\Users\\User\\.local\\bin\\claude.exe\n') };
const missWhere = { status: 1, stdout: Buffer.from('') };
const throwingExec = () => { throw new Error('spawn failed'); };
const fsAllow = (paths) => ({ existsSync: (p) => paths.includes(p) });
const envOf = (o) => o;

console.log('\n\x1b[1mclaude-dsv4f CLI tests\x1b[0m\n');
console.log('\x1b[1mresolveClaude()\x1b[0m');

check('non-Windows: returns "claude" without touching fs or where', () => {
  const r = resolveClaude({
    platform: 'linux',
    exec: throwingExec,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp',
  });
  assert.equal(r, 'claude');
});

check('Windows + where.exe finds claude: returns "claude" (no extension)', () => {
  // The whole point: cmd.exe with shell:true treats "claude.cmd" as fully-qualified
  // and skips PATHEXT. Returning "claude" lets PATHEXT resolve it to claude.exe.
  const r = resolveClaude({
    platform: 'win32',
    exec: (cmd, args) => cmd === 'where.exe' && args[0] === 'claude' ? okWhere : missWhere,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp/empty',
  });
  assert.equal(r, 'claude');
});

check('Windows + where.exe miss + ~/.local/bin/claude.exe exists: returns that path', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const candidate = path.join(home, '.local', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([candidate]),
    env: envOf({}),
    home,
  });
  assert.equal(r, candidate);
});

check('Windows + where.exe miss + APPDATA\\npm\\claude.cmd exists: returns that path', () => {
  const appdata = 'C:\\Users\\Test\\AppData\\Roaming';
  const r = resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([`${appdata}\\npm\\claude.cmd`]),
    env: envOf({ APPDATA: appdata }),
    home: '/tmp/empty',
  });
  assert.equal(r, `${appdata}\\npm\\claude.cmd`);
});

check('Windows + nothing found: throws with an actionable message', () => {
  assert.throws(() => resolveClaude({
    platform: 'win32',
    exec: () => missWhere,
    fsSync: fsAllow([]),
    env: envOf({}),
    home: '/tmp/empty',
  }), (err) => /Claude Code CLI not found/.test(err.message) && /claude\.com\/code/.test(err.message));
});

check('Windows + where.exe throws (sandboxed env): falls through to fallback paths', () => {
  const home = path.join(path.parse(os.tmpdir()).root, 'fakehome');
  const candidate = path.join(home, '.local', 'bin', 'claude.exe');
  const r = resolveClaude({
    platform: 'win32',
    exec: throwingExec,
    fsSync: fsAllow([candidate]),
    env: envOf({}),
    home,
  });
  assert.equal(r, candidate);
});

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
