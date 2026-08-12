#!/usr/bin/env node
/**
 * Tests for bin/dsv4f-opencode-convert.mjs against a synthetic SQLite fixture built to
 * match opencode's real schema (captured live from PC-4D, 10.147.18.245, 2026-08-12).
 *
 * The converter itself was additionally validated against REAL opencode data on that
 * machine by round-tripping a genuine session all the way through `claude --resume
 * <converted-uuid> --print` and getting back a real, correct DeepSeek reply (is_error:
 * false) — that is the test no synthetic fixture can substitute for, and it already passed
 * once by hand. These tests cover the structural properties that are cheap to check on every
 * run without needing a live opencode install.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import {
  convertSession, deterministicUuid, encodeProjectDir, listSessions, openDb,
} from './bin/dsv4f-opencode-convert.mjs';

const require = createRequire(import.meta.url);
const DatabaseSync = (() => { try { return require('node:sqlite').DatabaseSync; } catch { return null; } })();

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4f-oc-convert-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

console.log('\n\x1b[1mdsv4f-opencode-convert tests\x1b[0m\n');

if (!DatabaseSync) {
  console.log('\x1b[33mnode:sqlite unavailable (need Node 22.5+) — skipping all tests\x1b[0m\n');
  process.exit(0);
}

// ------------------------------------------------------- build a fixture db, real schema
const dbPath = path.join(SCRATCH, 'fixture.db');
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT, name TEXT);
  CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, directory TEXT,
    agent TEXT, model TEXT, time_created INTEGER);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
    time_created INTEGER, data TEXT);
`);
const insMsg = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)');
const insPart = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)');

// --- session A: plain text exchange, no tools
db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
  .run('ses_text', 'proj1', 'Plain chat', '/home/test/proj', 1000);
insMsg.run('msg_u1', 'ses_text', 1000, JSON.stringify({ role: 'user' }));
insPart.run('prt_u1', 'msg_u1', 'ses_text', 1000, JSON.stringify({ type: 'text', text: 'hello there' }));
insMsg.run('msg_a1', 'ses_text', 1001, JSON.stringify({ role: 'assistant', model: 'opencode/big-pickle' }));
insPart.run('prt_a1a', 'msg_a1', 'ses_text', 1001, JSON.stringify({ type: 'reasoning', text: 'thinking privately' }));
insPart.run('prt_a1b', 'msg_a1', 'ses_text', 1001, JSON.stringify({ type: 'text', text: 'hi back' }));
insPart.run('prt_a1c', 'msg_a1', 'ses_text', 1001, JSON.stringify({
  type: 'step-finish', reason: 'stop',
  tokens: { input: 10, output: 5, cache: { read: 2, write: 0 } },
}));

// --- session B: a tool call round-trip
db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
  .run('ses_tool', 'proj1', 'Tool use', 'C:\\Users\\test\\Documents\\proj', 2000);
insMsg.run('msg_u2', 'ses_tool', 2000, JSON.stringify({ role: 'user' }));
insPart.run('prt_u2', 'msg_u2', 'ses_tool', 2000, JSON.stringify({ type: 'text', text: 'search the docs' }));
insMsg.run('msg_a2', 'ses_tool', 2001, JSON.stringify({ role: 'assistant' }));
insPart.run('prt_a2a', 'msg_a2', 'ses_tool', 2001, JSON.stringify({ type: 'step-start' }));
insPart.run('prt_a2b', 'msg_a2', 'ses_tool', 2001, JSON.stringify({
  type: 'tool', tool: 'docs_search', callID: 'call_abc123',
  state: { status: 'completed', input: { query: 'pricing' }, output: '{"ok":true}' },
}));
insPart.run('prt_a2c', 'msg_a2', 'ses_tool', 2001, JSON.stringify({ type: 'step-finish', reason: 'tool-calls', tokens: {} }));

// --- session C: an unknown/future part type must degrade visibly, not vanish
db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
  .run('ses_unknown', 'proj1', 'Unknown part', '/home/test/proj', 3000);
insMsg.run('msg_a3', 'ses_unknown', 3000, JSON.stringify({ role: 'assistant' }));
insPart.run('prt_a3', 'msg_a3', 'ses_unknown', 3000, JSON.stringify({ type: 'future-part-type', payload: 'mystery' }));

// --- session D: an errored tool call
db.prepare('INSERT INTO session (id, project_id, title, directory, time_created) VALUES (?, ?, ?, ?, ?)')
  .run('ses_toolerr', 'proj1', 'Tool error', '/home/test/proj', 4000);
insMsg.run('msg_a4', 'ses_toolerr', 4000, JSON.stringify({ role: 'assistant' }));
insPart.run('prt_a4', 'msg_a4', 'ses_toolerr', 4000, JSON.stringify({
  type: 'tool', tool: 'broken_tool', callID: 'call_err1',
  state: { status: 'error', input: {}, output: 'boom' },
}));

// ----------------------------------------------------------------------------- tests

console.log('\x1b[1mplain text exchange\x1b[0m');
{
  const r = convertSession(db, 'ses_text');
  check('2 lines produced (user + assistant, no synthetic turns)', r.lines.length === 2, String(r.lines.length));
  check('user content is a plain string, not an array (single text block)',
    typeof r.lines[0].message.content === 'string' && r.lines[0].message.content === 'hello there');
  check('reasoning part dropped from assistant content', !JSON.stringify(r.lines[1].message.content).includes('thinking privately'));
  check('visible text survives', r.lines[1].message.content.some(b => b.type === 'text' && b.text === 'hi back'));
  check('step-finish usage tokens carried onto the assistant message',
    r.lines[1].message.usage.input_tokens === 10 && r.lines[1].message.usage.output_tokens === 5 &&
    r.lines[1].message.usage.cache_read_input_tokens === 2);
  check('session id is a real UUID', /^[0-9a-f-]{36}$/.test(r.sessionId), r.sessionId);
  check('message uuid is a real UUID', /^[0-9a-f-]{36}$/.test(r.lines[0].uuid), r.lines[0].uuid);
  check('parent chain: assistant.parentUuid === user.uuid', r.lines[1].parentUuid === r.lines[0].uuid);
  check('first line has no parent', r.lines[0].parentUuid === null);
}

console.log('\n\x1b[1mtool call round-trip\x1b[0m');
{
  const r = convertSession(db, 'ses_tool');
  check('4 lines: user, assistant(tool_use), synthetic user(tool_result)', r.lines.length === 3,
    String(r.lines.length));
  const asst = r.lines[1];
  const toolUse = asst.message.content.find(b => b.type === 'tool_use');
  check('tool_use block present with the right name/input', toolUse?.name === 'docs_search' &&
    toolUse.input.query === 'pricing');
  check('step-start produced no content block', !asst.message.content.some(b => b.type === 'step-start'));
  const toolResultLine = r.lines[2];
  check('synthetic tool_result message is role user', toolResultLine.message.role === 'user');
  const toolResult = toolResultLine.message.content.find(b => b.type === 'tool_result');
  check('tool_result.tool_use_id matches tool_use.id exactly', toolResult?.tool_use_id === toolUse.id);
  check('tool_result content carries the real output', toolResult?.content === '{"ok":true}');
  check('windows-style directory encodes to match Claude Code\'s real scheme (double dash after drive letter)',
    encodeProjectDir(r.directory) === 'C--Users-test-Documents-proj', encodeProjectDir(r.directory));
  check('linux-style directory encodes to match Claude Code\'s real scheme (leading dash)',
    encodeProjectDir('/home/fr0dz3e/some-project') === '-home-fr0dz3e-some-project',
    encodeProjectDir('/home/fr0dz3e/some-project'));
}

console.log('\n\x1b[1munknown part type degrades visibly instead of vanishing\x1b[0m');
{
  const r = convertSession(db, 'ses_unknown');
  const content = r.lines[0].message.content;
  check('unknown type produces a visible placeholder, not silence', content.length === 1 && content[0].type === 'text');
  check('placeholder names the unrecognised type', content[0].text.includes('future-part-type'));
  check('unknownTypes is reported back to the caller', r.unknownTypes.includes('future-part-type'));
}

console.log('\n\x1b[1merrored tool call\x1b[0m');
{
  const r = convertSession(db, 'ses_toolerr');
  const toolResult = r.lines[1].message.content.find(b => b.type === 'tool_result');
  check('is_error is set on a failed tool call', toolResult?.is_error === true);
}

console.log('\n\x1b[1mdeterministic UUIDs (idempotent re-import)\x1b[0m');
{
  const r1 = convertSession(db, 'ses_text');
  const r2 = convertSession(db, 'ses_text');
  check('same opencode session converts to the identical UUID every time',
    r1.sessionId === r2.sessionId);
  check('same opencode message converts to the identical uuid every time',
    r1.lines[0].uuid === r2.lines[0].uuid);
  check('different sessions never collide', r1.sessionId !== convertSession(db, 'ses_tool').sessionId);
  check('deterministicUuid is a real UUID format', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(deterministicUuid('anything')));
}

console.log('\n\x1b[1merror handling\x1b[0m');
{
  let threw = false;
  try { convertSession(db, 'no-such-session'); } catch { threw = true; }
  check('converting a missing session throws rather than returning garbage', threw);
}

console.log('\n\x1b[1mlistSessions / openDb\x1b[0m');
{
  const rows = listSessions(dbPath);
  check('listSessions finds all 4 fixture sessions', rows.length === 4, String(rows.length));
  check('listSessions is ordered by time_created', rows[0].id === 'ses_text' && rows[3].id === 'ses_toolerr');
  const db2 = openDb(dbPath);
  check('openDb returns a usable handle', db2.prepare('SELECT COUNT(*) AS n FROM session').get().n === 4);
  db2.close();
}

db.close();
console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
