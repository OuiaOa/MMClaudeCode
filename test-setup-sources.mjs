#!/usr/bin/env node
/**
 * Tests for bin/dsv4shim-setup-sources.mjs — the orchestration that turns the picker's
 * leave/copy/move/remove choices into real dsv4shim-import + dsv4shim-scrub calls. This is glue
 * code over already-unit-tested building blocks (dsv4shim-sources, dsv4shim-scrub,
 * dsv4shim-opencode-convert); what matters here is that it wires them together with the RIGHT
 * arguments and respects the shared-transcript independence rule (claude-desktop's
 * disposition must never scrub claude-cli's transcripts and vice versa).
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { applySourceDispositions } from './bin/dsv4shim-setup-sources.mjs';

const require = createRequire(import.meta.url);
const DatabaseSync = (() => { try { return require('node:sqlite').DatabaseSync; } catch { return null; } })();

const ROOT = path.resolve(import.meta.dirname);
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4shim-setup-sources-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}
const quiet = () => {}; // silence noisy real-world logging during tests

// ---------------------------------------------------------------- shared fixture builder
function buildClaudeFixture(root) {
  const claudeHome = path.join(root, 'claude-home');
  const proj = path.join(claudeHome, '.claude', 'projects', 'C--Users-test');
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'sessionA.jsonl'), '{"type":"user"}\n');
  fs.writeFileSync(path.join(proj, 'memory', 'MEMORY.md'), '# memory\n');
  return { claudeHome, transcriptRoot: path.join(claudeHome, '.claude', 'projects') };
}

function makeCliSource(transcriptRoot) {
  return {
    id: 'claude-cli', label: 'Claude Code CLI', present: true,
    binary: null, binaryOnPath: false, hasCredentials: false,
    paths: { profile: path.dirname(transcriptRoot), transcriptRoot, credentials: path.join(path.dirname(transcriptRoot), '.credentials.json') },
    stats: { sessions: 1, memories: 1 },
  };
}
function makeDesktopSource(transcriptRoot, sidecarsRoot) {
  return {
    id: 'claude-desktop', label: 'Claude Desktop', present: true,
    paths: { transcriptRoot, sessionSidecars: sidecarsRoot },
    stats: { sidecars: 1, sessions: 1, memories: 1 },
  };
}

console.log('\n\x1b[1mdsv4shim-setup-sources tests\x1b[0m\n');

// -------------------------------------------------------------------- copy-only, no scrub
console.log('\x1b[1mcopy: imports but never scrubs\x1b[0m');
{
  const dir = path.join(SCRATCH, 'copy-test');
  const { claudeHome, transcriptRoot } = buildClaudeFixture(dir);
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const cli = makeCliSource(transcriptRoot);
  await applySourceDispositions({
    sources: [cli],
    disposition: { 'claude-cli': 'copy' },
    node: process.execPath, ROOT, PROFILE_DIR: profileDir,
    importEnv: { HOME: claudeHome, DSV4SHIM_PROFILE: profileDir },
    importStdio: 'pipe', log: quiet, errorLog: quiet,
  });

  check('session imported into the dsv4shim profile',
    fs.existsSync(path.join(profileDir, 'projects', 'C--Users-test', 'sessionA.jsonl')));
  check('source transcript still present (copy never scrubs)',
    fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'sessionA.jsonl')));
  check('source memory file still present', fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'memory', 'MEMORY.md')));
}

// ---------------------------------------------------------------------- move: scrubs cli
console.log('\n\x1b[1mmove: imports then scrubs the source\x1b[0m');
{
  const dir = path.join(SCRATCH, 'move-test');
  const { claudeHome, transcriptRoot } = buildClaudeFixture(dir);
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const cli = makeCliSource(transcriptRoot);
  const summary = await applySourceDispositions({
    sources: [cli],
    disposition: { 'claude-cli': 'move' },
    node: process.execPath, ROOT, PROFILE_DIR: profileDir,
    importEnv: { HOME: claudeHome, DSV4SHIM_PROFILE: profileDir },
    importStdio: 'pipe', log: quiet, errorLog: quiet,
  });

  check('session imported into the dsv4shim profile',
    fs.existsSync(path.join(profileDir, 'projects', 'C--Users-test', 'sessionA.jsonl')));
  check('source transcript REMOVED after move', !fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'sessionA.jsonl')));
  check('source memory REMOVED after move', !fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'memory', 'MEMORY.md')));
  check('a backup exists somewhere under the profile', summary.cli && fs.existsSync(summary.cli.backupDir));
}

// ---------------------------------- shared-transcript independence: THE critical property
console.log('\n\x1b[1mshared-transcript independence: desktop move must NOT touch cli\'s transcripts\x1b[0m');
{
  const dir = path.join(SCRATCH, 'independence-test');
  const { claudeHome, transcriptRoot } = buildClaudeFixture(dir);
  const sidecarsRoot = path.join(dir, 'desktop-appdata', 'claude-code-sessions', 'ws', 'acct');
  fs.mkdirSync(sidecarsRoot, { recursive: true });
  fs.writeFileSync(path.join(sidecarsRoot, 'local_11111111-1111-1111-1111-111111111111.json'),
    JSON.stringify({ cliSessionId: 'sessionA' }));
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const cli = makeCliSource(transcriptRoot); // disposition: leave (not in the disposition map)
  const desktop = makeDesktopSource(transcriptRoot, sidecarsRoot); // disposition: remove

  await applySourceDispositions({
    sources: [cli, desktop],
    disposition: { 'claude-desktop': 'remove' }, // cli deliberately absent -> defaults to 'leave'
    node: process.execPath, ROOT, PROFILE_DIR: profileDir,
    importEnv: { HOME: claudeHome, DSV4SHIM_PROFILE: profileDir },
    importStdio: 'pipe', log: quiet, errorLog: quiet,
  });

  check('the shared transcript SURVIVES — cli is at "leave", only desktop asked to remove',
    fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'sessionA.jsonl')));
  check('desktop\'s own sidecar IS removed',
    !fs.existsSync(path.join(sidecarsRoot, 'local_11111111-1111-1111-1111-111111111111.json')));
  check('the transcript was still imported into dsv4shim (desktop\'s "remove" still copies first)',
    fs.existsSync(path.join(profileDir, 'projects', 'C--Users-test', 'sessionA.jsonl')));
}

// --------------------------------------------------------------------------- leave: no-op
console.log('\n\x1b[1mleave: touches nothing at all\x1b[0m');
{
  const dir = path.join(SCRATCH, 'leave-test');
  const { claudeHome, transcriptRoot } = buildClaudeFixture(dir);
  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const cli = makeCliSource(transcriptRoot);
  await applySourceDispositions({
    sources: [cli],
    disposition: { 'claude-cli': 'leave' },
    node: process.execPath, ROOT, PROFILE_DIR: profileDir,
    importEnv: { HOME: claudeHome, DSV4SHIM_PROFILE: profileDir },
    importStdio: 'pipe', log: quiet, errorLog: quiet,
  });

  check('nothing imported', !fs.existsSync(path.join(profileDir, 'projects')));
  check('source untouched', fs.existsSync(path.join(transcriptRoot, 'C--Users-test', 'sessionA.jsonl')));
}

// ---------------------------------------------------------------------------- opencode
console.log('\n\x1b[1mopencode: move imports then scrubs the db\x1b[0m');
if (!DatabaseSync) {
  check('node:sqlite available for this test run', false, 'Node < 22.5 — skipping opencode orchestration tests');
} else {
  const dir = path.join(SCRATCH, 'opencode-test');
  const dbDir = path.join(dir, 'oc-data');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT, model TEXT, time_created INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
  `);
  db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('ses_1', 'p1', 'Test', '/home/test/proj', 1000);
  db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
    .run('msg_1', 'ses_1', 1000, JSON.stringify({ role: 'user' }));
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
    .run('prt_1', 'msg_1', 'ses_1', 1000, JSON.stringify({ type: 'text', text: 'hi' }));
  // an empty session — must be skipped, not scrubbed (nothing was actually imported from it)
  db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
    .run('ses_empty', 'p1', 'Empty', '/home/test/proj', 900);
  db.close();

  const profileDir = path.join(dir, 'profile');
  fs.mkdirSync(profileDir, { recursive: true });
  const opencode = { id: 'opencode', label: 'opencode', present: true, paths: { dataDir: dbDir, db: dbPath }, stats: { sessions: 2 } };

  const summary = await applySourceDispositions({
    sources: [opencode],
    disposition: { opencode: 'move' },
    node: process.execPath, ROOT, PROFILE_DIR: profileDir,
    importStdio: 'pipe', log: quiet, errorLog: quiet,
  });

  check('the real session converted and written', summary.opencode.converted === 1, JSON.stringify(summary.opencode));
  check('the empty session was not counted as converted', !summary.opencode.importedIds.includes('ses_empty'));
  check('exactly one file landed in the profile',
    fs.readdirSync(path.join(profileDir, 'projects', '-home-test-proj')).length === 1);

  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  check('ses_1 removed from opencode.db after move', !db2.prepare('SELECT 1 FROM session WHERE id=?').get('ses_1'));
  check('ses_empty (never imported) still exists — scrub only touches what was actually imported',
    !!db2.prepare('SELECT 1 FROM session WHERE id=?').get('ses_empty'));
  db2.close();
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
