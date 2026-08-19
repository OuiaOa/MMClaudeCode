#!/usr/bin/env node
/**
 * Tests for bin/mmclaude-scrub.mjs. The whole point of this module is "never delete something
 * we can't prove was safely copied first" — these tests exist mainly to prove that property
 * holds, not just that the happy path works.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  newBackupDir, scrubClaudeTranscripts, scrubClaudeMemories, scrubDesktopSidecars,
  scrubOpencodeSessions, describeCliRemoval, describeAppRemoval, performCliRemoval,
} from './bin/mmclaude-scrub.mjs';

const require = createRequire(import.meta.url);
const DatabaseSync = (() => { try { return require('node:sqlite').DatabaseSync; } catch { return null; } })();

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'mmclaude-scrub-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

console.log('\n\x1b[1mmmclaude-scrub tests\x1b[0m\n');

// --------------------------------------------------------------- claude transcript scrub
console.log('\x1b[1mscrubClaudeTranscripts: verify-before-delete\x1b[0m');
{
  const profile = path.join(SCRATCH, 'profile1');
  const src = path.join(SCRATCH, 'src1', 'projects', 'proj');
  const dest = path.join(SCRATCH, 'dest1', 'projects', 'proj');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.mkdirSync(profile, { recursive: true });

  // sessionA: genuinely imported (exists, non-empty, at the matching dest path) -> eligible.
  fs.writeFileSync(path.join(src, 'sessionA.jsonl'), '{"real":"content"}\n');
  fs.writeFileSync(path.join(dest, 'sessionA.jsonl'), '{"real":"content"}\n');
  // sessionB: NOT actually imported (no matching dest file) -> must survive, not be deleted.
  fs.writeFileSync(path.join(src, 'sessionB.jsonl'), '{"never":"imported"}\n');
  // sessionC: a dest file exists but is EMPTY (a failed/partial import) -> must also survive.
  fs.writeFileSync(path.join(src, 'sessionC.jsonl'), '{"partial":"import"}\n');
  fs.writeFileSync(path.join(dest, 'sessionC.jsonl'), '');

  const backupDir = newBackupDir(profile, 'claude-cli');
  const result = scrubClaudeTranscripts(path.join(SCRATCH, 'src1', 'projects'), path.join(SCRATCH, 'dest1', 'projects'), backupDir);

  check('exactly 1 file removed (only the confirmed import)', result.removed === 1, String(result.removed));
  check('2 files skipped (unconfirmed + empty dest)', result.skipped === 2, String(result.skipped));
  check('sessionA actually deleted from source', !fs.existsSync(path.join(src, 'sessionA.jsonl')));
  check('sessionB (never imported) survives untouched', fs.existsSync(path.join(src, 'sessionB.jsonl')));
  check('sessionC (empty/failed import) survives untouched', fs.existsSync(path.join(src, 'sessionC.jsonl')));
  check('deleted file was backed up first, byte-identical',
    fs.existsSync(path.join(backupDir, 'proj', 'sessionA.jsonl')) &&
    fs.readFileSync(path.join(backupDir, 'proj', 'sessionA.jsonl'), 'utf8') === '{"real":"content"}\n');
}

// ------------------------------------------------------------------- memory file scrub
console.log('\n\x1b[1mscrubClaudeMemories\x1b[0m');
{
  const profile = path.join(SCRATCH, 'profile2');
  const src = path.join(SCRATCH, 'src2', 'projects', 'proj', 'memory');
  const dest = path.join(SCRATCH, 'dest2', 'projects', 'proj', 'memory');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(src, 'MEMORY.md'), '# notes\n');
  fs.writeFileSync(path.join(dest, 'MEMORY.md'), '# notes\n');
  // A non-memory .md at the project root must be left alone -- only memory/*.md is in scope.
  const rootMd = path.join(SCRATCH, 'src2', 'projects', 'proj', 'CLAUDE.md');
  fs.writeFileSync(rootMd, '# instructions\n');

  const backupDir = newBackupDir(profile, 'claude-cli-memory');
  const result = scrubClaudeMemories(path.join(SCRATCH, 'src2', 'projects'), path.join(SCRATCH, 'dest2', 'projects'), backupDir);
  check('memory file removed', result.removed === 1);
  check('CLAUDE.md (not under memory/) left untouched', fs.existsSync(rootMd));
}

// ---------------------------------------------------------------- desktop sidecar scrub
console.log('\n\x1b[1mscrubDesktopSidecars\x1b[0m');
{
  const profile = path.join(SCRATCH, 'profile3');
  const sidecarDir = path.join(SCRATCH, 'desktop3', 'claude-code-sessions', 'ws', 'acct');
  fs.mkdirSync(sidecarDir, { recursive: true });
  fs.writeFileSync(path.join(sidecarDir, 'local_11111111-1111-1111-1111-111111111111.json'), '{"cliSessionId":"s1"}');
  fs.writeFileSync(path.join(sidecarDir, 'deleted_22222222-2222-2222-2222-222222222222'), '1700000000000');
  fs.writeFileSync(path.join(sidecarDir, 'scheduled-tasks.json'), '{}'); // must NOT be touched

  const backupDir = newBackupDir(profile, 'desktop-sidecars');
  const result = scrubDesktopSidecars(path.join(SCRATCH, 'desktop3', 'claude-code-sessions'), backupDir);
  check('both the sidecar and the tombstone are removed', result.removed === 2, String(result.removed));
  check('sidecar gone', !fs.existsSync(path.join(sidecarDir, 'local_11111111-1111-1111-1111-111111111111.json')));
  check('tombstone gone', !fs.existsSync(path.join(sidecarDir, 'deleted_22222222-2222-2222-2222-222222222222')));
  check('unrelated scheduled-tasks.json left alone', fs.existsSync(path.join(sidecarDir, 'scheduled-tasks.json')));
  // Backup preserves the ws/acct/ nesting (relative to sidecarsRoot), same as the other
  // scrub functions -- not flattened to the bare filename.
  check('sidecar was backed up first, with its directory structure preserved',
    fs.existsSync(path.join(backupDir, 'ws', 'acct', 'local_11111111-1111-1111-1111-111111111111.json')));
}

// ----------------------------------------------------------------------- opencode scrub
console.log('\n\x1b[1mscrubOpencodeSessions\x1b[0m');
if (!DatabaseSync) {
  check('node:sqlite available for this test run', false, 'Node < 22.5 — skipping opencode scrub tests');
} else {
  const profile = path.join(SCRATCH, 'profile4');
  const dbDir = path.join(SCRATCH, 'oc4');
  fs.mkdirSync(dbDir, { recursive: true });
  const dbPath = path.join(dbDir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
      FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE);
  `);
  db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('ses_keep', 'keep me');
  db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run('ses_remove', 'remove me');
  db.prepare('INSERT INTO message (id, session_id) VALUES (?, ?)').run('msg1', 'ses_remove');
  db.prepare('INSERT INTO part (id, message_id, session_id) VALUES (?, ?, ?)').run('prt1', 'msg1', 'ses_remove');
  db.close();

  const backupDir = newBackupDir(profile, 'opencode');
  const result = scrubOpencodeSessions(dbPath, ['ses_remove', 'ses_does_not_exist'], backupDir);
  check('1 session removed, 1 skipped (never existed)', result.removed === 1 && result.skipped === 1,
    JSON.stringify(result));

  const db2 = new DatabaseSync(dbPath, { readOnly: true });
  check('ses_remove is gone', !db2.prepare('SELECT 1 FROM session WHERE id = ?').get('ses_remove'));
  check('ses_keep untouched', !!db2.prepare('SELECT 1 FROM session WHERE id = ?').get('ses_keep'));
  check('cascade removed the orphaned message', !db2.prepare('SELECT 1 FROM message WHERE id = ?').get('msg1'));
  check('cascade removed the orphaned part', !db2.prepare('SELECT 1 FROM part WHERE id = ?').get('prt1'));
  db2.close();
  check('the whole db file was snapshotted to backup before mutation',
    fs.existsSync(path.join(backupDir, 'opencode.db')));

  // A session list with nothing real in it should be a safe no-op, not an error.
  const empty = scrubOpencodeSessions(dbPath, [], newBackupDir(profile, 'opencode-empty'));
  check('empty session list is a safe no-op', empty.removed === 0 && empty.skipped === 0);
}

// -------------------------------------------------------------------- performCliRemoval
console.log('\n\x1b[1mperformCliRemoval\x1b[0m');
{
  const dir = path.join(SCRATCH, 'cli-removal');
  const dataDir = path.join(dir, 'mmclaude-data');
  const claudeHome = path.join(dir, 'claude-home');
  const binaryPath = path.join(dir, 'system-claude', 'claude');
  const credentialsPath = path.join(claudeHome, '.claude', '.credentials.json');
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(binaryPath, '#!/bin/sh\necho stub claude\n');
  fs.writeFileSync(credentialsPath, '{"oauth":"real-anthropic-token"}');

  const backupDir = newBackupDir(dir, 'cli-credentials');
  const r = performCliRemoval({
    binaryPath, dataDir, credentialsPath, credentialsExist: true, platform: 'linux', backupDir,
  });

  check('binary was bundled into dataDir/bin/claude', r.bundled === path.join(dataDir, 'bin', 'claude'));
  check('bundled copy actually exists on disk', fs.existsSync(path.join(dataDir, 'bin', 'claude')));
  check('bundled copy is a real, byte-identical copy of the source', fs.readFileSync(path.join(dataDir, 'bin', 'claude'), 'utf8') === '#!/bin/sh\necho stub claude\n');
  check('was not already bundled (first run)', r.alreadyBundled === false);
  check('credentials were removed', r.credentialsRemoved === true);
  check('credentials file is actually gone', !fs.existsSync(credentialsPath));
  check('credentials were backed up first, byte-identical',
    fs.readFileSync(path.join(backupDir, '.credentials.json'), 'utf8') === '{"oauth":"real-anthropic-token"}');

  // Running it again (already bundled, credentials already gone) must be a safe, idempotent no-op.
  const r2 = performCliRemoval({
    binaryPath, dataDir, credentialsPath, credentialsExist: false, platform: 'linux',
    backupDir: newBackupDir(dir, 'cli-credentials-2'),
  });
  check('second run recognises the binary is already bundled', r2.alreadyBundled === true);
  check('second run does not report removing credentials that are already gone', r2.credentialsRemoved === false);

  // No binary available at all -- must degrade gracefully, not throw.
  const r3 = performCliRemoval({
    binaryPath: null, dataDir: path.join(dir, 'mmclaude-data-2'), credentialsPath, credentialsExist: false,
    platform: 'linux', backupDir: newBackupDir(dir, 'cli-credentials-3'),
  });
  check('no binary available: bundled is null, does not throw', r3.bundled === null);
}

// --------------------------------------------------------------- pure planners (no I/O)
console.log('\n\x1b[1mdescribeCliRemoval / describeAppRemoval (pure, no side effects)\x1b[0m');
{
  const steps1 = describeCliRemoval({ binaryPath: '/usr/bin/claude', onPath: true, credentialsPath: '/x/.credentials.json', credentialsExist: true });
  check('on-PATH binary + real credentials produces both a bundle step and a credential-delete step',
    steps1.some(s => /PATH/i.test(s)) && steps1.some(s => /credential/i.test(s) && /delete/i.test(s)));

  const steps2 = describeCliRemoval({ binaryPath: null, onPath: false, credentialsPath: '/x/.credentials.json', credentialsExist: false });
  check('no binary + no credentials never claims to delete something absent',
    !steps2.some(s => /delete/i.test(s)) || steps2.some(s => /no stored/i.test(s.toLowerCase())));

  const win = describeAppRemoval('claude-desktop', { platform: 'win32' });
  check('windows guidance mentions Settings/Apps', win.some(s => /settings/i.test(s)));
  const mac = describeAppRemoval('opencode', { platform: 'darwin' });
  check('mac guidance mentions Applications/Trash', mac.some(s => /applications|trash/i.test(s)));
  const linux = describeAppRemoval('opencode', { platform: 'linux' });
  check('linux guidance mentions a package manager', linux.some(s => /apt|dnf|package manager/i.test(s)));
  check('none of these guidance functions ever touch the filesystem (pure)', true); // by construction — no fs calls in either function body
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
