#!/usr/bin/env node
/**
 * Tests for bin/dsv4shim-sources.mjs — detection of Claude Code CLI, Claude Desktop, and
 * opencode, against synthetic fixtures shaped like the real installs verified on PC-4D
 * (10.147.18.245) on 2026-08-12.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  claudeTranscriptRoot, findClaudeBinary, desktopDataDir, opencodeDataDir,
  desktopSidecars, opencodeStats, detectSources, loadSqlite,
} from './bin/dsv4shim-sources.mjs';

const require = createRequire(import.meta.url);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-sources-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

console.log('\n\x1b[1mdsv4shim-sources tests\x1b[0m\n');

// ------------------------------------------------------------- fixture: nothing installed
console.log('\x1b[1mnothing installed\x1b[0m');
{
  const home = path.join(SCRATCH, 'empty-home');
  fs.mkdirSync(home, { recursive: true });
  const sources = detectSources({ home, env: {}, platform: 'linux' });
  check('all three sources report absent', sources.every(s => !s.present),
    JSON.stringify(sources.map(s => [s.id, s.present])));
  check('claude-cli stats are zero, not crashed', sources.find(s => s.id === 'claude-cli').stats.sessions === 0);
}

// --------------------------------------------------------- fixture: Claude Code CLI only
console.log('\n\x1b[1mClaude Code CLI only (Linux-shaped)\x1b[0m');
{
  const home = path.join(SCRATCH, 'cli-only-home');
  const proj = path.join(home, '.claude', 'projects', 'C--Users-test');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sessionA.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(proj, 'sessionB.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(proj, 'memory', 'MEMORY.md'), '# memory\n');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/bin/sh\necho stub\n', { mode: 0o755 });
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}');

  const sources = detectSources({ home, env: {}, platform: 'linux' });
  const cli = sources.find(s => s.id === 'claude-cli');
  const desktop = sources.find(s => s.id === 'claude-desktop');
  const oc = sources.find(s => s.id === 'opencode');

  check('claude-cli present', cli.present);
  check('claude-cli finds the binary off-PATH', cli.binary === path.join(home, '.local', 'bin', 'claude'));
  check('claude-cli reports 2 transcripts', cli.stats.sessions === 2, String(cli.stats.sessions));
  check('claude-cli reports 1 memory file', cli.stats.memories === 1, String(cli.stats.memories));
  check('claude-cli reports credentials present', cli.hasCredentials === true);
  check('claude-desktop absent (no appdata dir)', desktop.present === false);
  check('opencode absent (no db)', oc.present === false);
}

// ---------------------------------------------------- fixture: Claude Desktop (Windows-shaped)
console.log('\n\x1b[1mClaude Desktop, sharing transcripts with the CLI (Windows-shaped)\x1b[0m');
{
  const home = path.join(SCRATCH, 'desktop-home');
  const env = { APPDATA: path.join(home, 'AppData', 'Roaming') };
  const proj = path.join(home, '.claude', 'projects', 'C--Users-test');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'ses1.jsonl'), '{"type":"user"}\n');

  const sidecarDir = path.join(env.APPDATA, 'Claude', 'claude-code-sessions', 'ws1', 'acct1');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, 'local_11111111-1111-1111-1111-111111111111.json'),
    JSON.stringify({ cliSessionId: 'ses1', title: 'Test session', cwd: 'C:\\Users\\test' }));
  fs.writeFileSync(path.join(sidecarDir, 'local_22222222-2222-2222-2222-222222222222.json'),
    JSON.stringify({ cliSessionId: 'ses2', title: 'Another', cwd: 'C:\\Users\\test' }));
  // A malformed sidecar must still be reported (so it can be scrubbed), not crash detection.
  fs.writeFileSync(path.join(sidecarDir, 'local_33333333-3333-3333-3333-333333333333.json'), 'not json');
  // A deleted-session tombstone -- not a local_*.json sidecar, must NOT be counted as one.
  fs.writeFileSync(path.join(sidecarDir, 'deleted_44444444-4444-4444-4444-444444444444'), '1700000000000');

  const sources = detectSources({ home, env, platform: 'win32' });
  const desktop = sources.find(s => s.id === 'claude-desktop');
  const cli = sources.find(s => s.id === 'claude-cli');

  check('claude-desktop present', desktop.present);
  check('exactly 3 local_*.json sidecars counted (not the tombstone)', desktop.stats.sidecars === 3,
    String(desktop.stats.sidecars));
  check('malformed sidecar still reported (recoverable, not dropped)',
    desktop.sidecars.some(s => s.file.includes('33333333')));
  check('malformed sidecar has null fields rather than throwing',
    desktop.sidecars.find(s => s.file.includes('33333333')).cliSessionId === null);
  check('well-formed sidecar carries its cliSessionId through',
    desktop.sidecars.find(s => s.file.includes('11111111'))?.cliSessionId === 'ses1');
  check('desktop transcript count matches the shared root (1 jsonl)', desktop.stats.sessions === 1);
  check('cli and desktop point at the identical transcriptRoot (no double-counting)',
    cli.paths.transcriptRoot === desktop.paths.transcriptRoot);
}

// --------------------------------------------------------------------- fixture: opencode
console.log('\n\x1b[1mopencode (real schema, via node:sqlite)\x1b[0m');
{
  const DatabaseSync = loadSqlite();
  if (!DatabaseSync) {
    check('node:sqlite available for this test run', false, 'Node < 22.5 — skipping opencode fixture');
  } else {
    const home = path.join(SCRATCH, 'opencode-home');
    const dbDir = path.join(home, '.local', 'share', 'opencode');
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    // Minimal shape of the real schema captured from a live opencode.db on 2026-08-12 --
    // only the columns detection/conversion actually reads.
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT,
        agent TEXT, model TEXT, time_created INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
        time_created INTEGER, data TEXT);
    `);
    db.prepare('INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)').run('global', '/', null);
    db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
      .run('ses_1', 'global', 'Test session', '/home/test', 1000);
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('msg_1', 'ses_1', 1000, JSON.stringify({ role: 'user' }));
    db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
      .run('msg_2', 'ses_1', 1001, JSON.stringify({ role: 'assistant', parentID: 'msg_1' }));
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
      .run('prt_1', 'msg_1', 'ses_1', 1000, JSON.stringify({ type: 'text', text: 'hello' }));
    db.close();

    const sources = detectSources({ home, env: {}, platform: 'linux' });
    const oc = sources.find(s => s.id === 'opencode');
    check('opencode present', oc.present);
    check('opencode reports 1 session', oc.stats.sessions === 1, String(oc.stats.sessions));
    check('opencode reports 2 messages', oc.stats.messages === 2, String(oc.stats.messages));
    check('opencode reports 1 part', oc.stats.parts === 1, String(oc.stats.parts));
    check('opencode reports no error', oc.stats.error === null);

    // A corrupt/non-SQLite file at the expected path must degrade to a reported error, not throw.
    const badPath = path.join(dbDir, 'opencode-corrupt.db');
    fs.writeFileSync(badPath, 'not a real database');
    const badStats = opencodeStats(badPath);
    check('corrupt db reports an error instead of throwing', typeof badStats.error === 'string' && badStats.error.length > 0);
  }
}

// ----------------------------------------------------------- platform path resolution
console.log('\n\x1b[1mplatform-specific path resolution\x1b[0m');
{
  // path.join uses POSIX separators when this test runs on Linux regardless of the
  // simulated `platform` param (path.join isn't platform-aware, only path.win32.join is) --
  // check the meaningful part (APPDATA was honoured, "Claude" was appended) rather than an
  // exact separator match. The real Windows separator behavior was already verified live
  // against PC-4D's actual filesystem in dsv4shim-multi-source-import notes.
  check('desktop dir on win32 uses APPDATA',
    desktopDataDir({ home: '/home/x', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' }, platform: 'win32' })
      === path.join('C:\\Users\\x\\AppData\\Roaming', 'Claude'));
  check('desktop dir on darwin uses Library/Application Support',
    desktopDataDir({ home: '/Users/x', env: {}, platform: 'darwin' }) === '/Users/x/Library/Application Support/Claude');
  check('desktop dir on linux uses .config',
    desktopDataDir({ home: '/home/x', env: {}, platform: 'linux' }) === '/home/x/.config/Claude');
  check('opencode dir is XDG-shaped on every platform, including Windows',
    opencodeDataDir({ home: 'C:\\Users\\x', env: {} }) === path.join('C:\\Users\\x', '.local', 'share', 'opencode'));
  check('opencode dir honours XDG_DATA_HOME when set',
    opencodeDataDir({ home: '/home/x', env: { XDG_DATA_HOME: '/custom/data' } }) === path.join('/custom/data', 'opencode'));
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
