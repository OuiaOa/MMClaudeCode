#!/usr/bin/env node
/**
 * Tests for bin/dsv4f-import — the recursive walk, the --source flag, and the
 * no-source-no-TTY hard-exit.
 *
 * The current implementation only walks the top level of each project subdir, so
 * subagent transcripts and tool-result blobs are silently dropped. These tests
 * fail against the current code and pass once the recursive walk is in.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname);
const IMPORT = path.join(ROOT, 'bin', 'dsv4f-import');

// Scratch root for the whole run — cleaned on exit.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4f-import-test-'));
process.on('exit', () => { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch {} });

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

function runImport(args, { env } = {}) {
  return spawnSync(process.execPath, [IMPORT, ...args], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

// ----------------------------------------------------- fixture: a realistic Claude Code profile
function buildFixture() {
  const home = path.join(SCRATCH, 'home-with-source');
  fs.mkdirSync(home, { recursive: true });
  const claude = path.join(home, '.claude');
  const proj = path.join(claude, 'projects', 'C--Users-test');
  fs.mkdirSync(path.join(proj, 'session-A', 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'session-A', 'tool-results'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'memory'), { recursive: true });

  // top-level session transcript (a real-shape JSON-Lines entry)
  fs.writeFileSync(path.join(proj, 'session-A.jsonl'),
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]},"sessionId":"sA"}\n' +
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi back"}]},"sessionId":"sA"}\n');

  // subagent transcript nested under the session
  fs.writeFileSync(path.join(proj, 'session-A', 'subagents', 'agent-aaa.jsonl'),
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"sub work"}]},"sessionId":"sA"}\n');
  fs.writeFileSync(path.join(proj, 'session-A', 'subagents', 'agent-aaa.meta.json'),
    '{"agentName":"test","model":"deepseek-v4-flash-sub"}');

  // tool-result blob — must be copied byte-identical
  const blob = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\nbinary blob content here\x00\x01\x02\x03');
  fs.writeFileSync(path.join(proj, 'session-A', 'tool-results', 'webfetch-1234-abcd.pdf'), blob);

  // nested .meta.json to be copied verbatim
  fs.writeFileSync(path.join(proj, 'session-A', '.session-A.meta.json'), '{"cwd":"/c/Users/test"}');

  // memory directory
  fs.writeFileSync(path.join(proj, 'memory', 'MEMORY.md'), '# Memory Index\n\n- [Test note](test.md)\n');
  fs.writeFileSync(path.join(proj, 'memory', 'test.md'), 'test note content');

  // also a project without the dsv4f skip — just to make sure the loop handles >1
  const proj2 = path.join(claude, 'projects', 'C--Users-other');
  fs.mkdirSync(proj2, { recursive: true });
  fs.writeFileSync(path.join(proj2, 'session-B.jsonl'), '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"x"}]},"sessionId":"sB"}\n');

  // portable config at the root of ~/.claude
  fs.mkdirSync(path.join(claude, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'agents', 'my-agent.md'), '# agent');
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# user claude');

  return { home, src: claude };
}

console.log('\n\x1b[1mclaude-dsv4f import tests\x1b[0m\n');
console.log('\x1b[1mrecursive walk\x1b[0m');

// --- test 1: recursive walk picks up subagent jsonl, meta, blobs, memory
{
  const { src } = buildFixture();
  const dst = path.join(SCRATCH, 'dst-recursive');
  const r = runImport(['--source', src, '--force'], { env: { CLAUDE_DSV4F_PROFILE: dst } });

  check('import exits 0', r.status === 0, `stderr: ${r.stderr}`);

  const dstProj = path.join(dst, 'projects', 'C--Users-test');
  check('main session jsonl at top level',
    fs.existsSync(path.join(dstProj, 'session-A.jsonl')));

  check('subagent jsonl at <session>/subagents/ copied (was the bug)',
    fs.existsSync(path.join(dstProj, 'session-A', 'subagents', 'agent-aaa.jsonl')));

  check('subagent meta.json copied verbatim',
    fs.existsSync(path.join(dstProj, 'session-A', 'subagents', 'agent-aaa.meta.json')));

  check('tool-results blob copied',
    fs.existsSync(path.join(dstProj, 'session-A', 'tool-results', 'webfetch-1234-abcd.pdf')));

  if (fs.existsSync(path.join(dstProj, 'session-A', 'tool-results', 'webfetch-1234-abcd.pdf'))) {
    const a = fs.readFileSync(path.join(SCRATCH, 'home-with-source', '.claude', 'projects', 'C--Users-test', 'session-A', 'tool-results', 'webfetch-1234-abcd.pdf'));
    const b = fs.readFileSync(path.join(dstProj, 'session-A', 'tool-results', 'webfetch-1234-abcd.pdf'));
    check('tool-results blob byte-identical', a.equals(b), `src=${a.length}B dst=${b.length}B`);
  }

  check('memory dir copied',
    fs.existsSync(path.join(dstProj, 'memory', 'MEMORY.md')) &&
    fs.existsSync(path.join(dstProj, 'memory', 'test.md')));

  check('second project dir also copied (loop handles N)',
    fs.existsSync(path.join(dst, 'projects', 'C--Users-other', 'session-B.jsonl')));

  check('root CLAUDE.md copied',
    fs.existsSync(path.join(dst, 'CLAUDE.md')));

  check('agents/ dir copied',
    fs.existsSync(path.join(dst, 'agents', 'my-agent.md')));
}

// --- test 2: --source flag is respected (no interactive prompt even if no ~/.claude)
console.log('\n\x1b[1m--source flag\x1b[0m');
{
  const { src, home } = buildFixture();
  const dst = path.join(SCRATCH, 'dst-source-flag');
  // HOME is set to a dir with NO .claude; --source overrides; no stdin (stdio:'ignore')
  const r = runImport(['--source', src, '--force'], { env: { HOME: home, USERPROFILE: home, CLAUDE_DSV4F_PROFILE: dst } });
  check('import with --source succeeds when ~/.claude absent',
    r.status === 0, `stderr: ${r.stderr}`);
}

// --- test 3: missing source + no TTY → hard exit with --source hint
console.log('\n\x1b[1msource missing + no TTY\x1b[0m');
{
  const bareHome = path.join(SCRATCH, 'home-empty');
  fs.mkdirSync(bareHome, { recursive: true });
  const dst = path.join(SCRATCH, 'dst-missing');
  const r = runImport(['--force'], { env: { HOME: bareHome, USERPROFILE: bareHome, CLAUDE_DSV4F_PROFILE: dst } });
  check('non-zero exit when source missing and no --source', r.status !== 0, `exit=${r.status}`);
  const msg = (r.stderr || '') + (r.stdout || '');
  check('error message mentions --source flag',
    /--source/.test(msg), `msg: ${msg.split('\n').find(Boolean) || ''}`);
}

// --- test 4: scrubbing still strips thinking blocks (regression guard for the new walker)
console.log('\n\x1b[1mscrub still strips thinking blocks\x1b[0m');
{
  const home = path.join(SCRATCH, 'home-scrub');
  fs.mkdirSync(home, { recursive: true });
  const proj = path.join(home, '.claude', 'projects', 'C--Users-scrub');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's1.jsonl'),
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"deep thoughts","signature":"abc"},{"type":"text","text":"visible answer"}]}}\n');

  const dst = path.join(SCRATCH, 'dst-scrub');
  const r = runImport(['--source', path.join(home, '.claude'), '--force'], { env: { CLAUDE_DSV4F_PROFILE: dst } });
  check('scrub import exits 0', r.status === 0, r.stderr);

  const dstFile = path.join(dst, 'projects', 'C--Users-scrub', 's1.jsonl');
  if (fs.existsSync(dstFile)) {
    const txt = fs.readFileSync(dstFile, 'utf8');
    const j = JSON.parse(txt.trim().split('\n')[0]);
    const types = (j.message.content || []).map(b => b.type);
    check('thinking block dropped by scrub', !types.includes('thinking'), `types=${JSON.stringify(types)}`);
    check('text block preserved', types.includes('text'), `types=${JSON.stringify(types)}`);
  } else {
    check('scrub output file exists', false, 'dst file missing');
  }
}

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail > 0 ? 1 : 0);
