#!/usr/bin/env node
/**
 * End-to-end test for the claude-dsv4f shim against a mock DeepSeek Anthropic endpoint.
 * Verifies the effort translation (especially xhigh->max, which is what makes ultracode
 * work), slot routing, model allowlist, cache hygiene, streaming usage capture and the cap.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsv4f-test-'));
const CONFIG_DIR = path.join(TMP, 'config');
const DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(CONFIG_DIR); fs.mkdirSync(DATA_DIR);

const MOCK_PORT = 9911;
const SHIM_PORT = 8799;
const SENTINEL = 'test-sentinel-abc';

fs.writeFileSync(path.join(CONFIG_DIR, 'key'), 'sk-test-key');
fs.writeFileSync(path.join(CONFIG_DIR, 'sentinel'), SENTINEL);
fs.writeFileSync(path.join(CONFIG_DIR, 'deepinfra-key'), 'di-test-key');

const VISION_PORT = 9912;

// The repo's own shipped default, not the machine's live ~/.config/claude-dsv4f/config.json —
// the suite must pass on a fresh checkout (a new contributor, CI, a worktree with no install
// on the box at all), not only on a machine that already has this tool set up.
const realCfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.default.json'), 'utf8'));
// Resolve the shim next to this test, so a worktree tests its own code and not the install.
const cfg = {
  ...realCfg,
  port: SHIM_PORT,
  upstream: `http://127.0.0.1:${MOCK_PORT}/anthropic`,
  balance: { settleSeconds: 99999, idlePollSeconds: 99999, lowBalanceWarnUsd: 5 },
  cap: { dailyUsd: 5.0 },
  vision: { ...realCfg.vision, endpoint: `http://127.0.0.1:${VISION_PORT}/v1/openai/chat/completions` },
};
fs.writeFileSync(path.join(CONFIG_DIR, 'config.json'), JSON.stringify(cfg, null, 2));
fs.writeFileSync(path.join(CONFIG_DIR, 'probe-results.json'), JSON.stringify({
  effortField: 'output_config', effortSupported: true, usageHasCacheFields: true,
  countTokensSupported: false, thinkingDisabledHonored: true,
}));

// ------------------------------------------------------------------ mock upstream
const seen = [];
let classifierRetryAttempts = 0;
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', d => { b += d; });
  req.on('end', () => {
    const body = JSON.parse(b || '{}');
    seen.push({ path: req.url, body, auth: req.headers.authorization });

    // Test hook: a classifier-shaped request carrying this marker fails the connection
    // (no response at all — simulating a stall/reset) on its first two attempts, then
    // succeeds on the third. Exercises the shim's classifier-only retry-with-backoff.
    if (/RETRY_TEST_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      classifierRetryAttempts++;
      if (classifierRetryAttempts <= 2) { req.socket.destroy(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_retry_ok', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 50, output_tokens: 5 },
      }));
      return;
    }

    // Test hook: 200 status but a body that isn't JSON — still billed by upstream, must
    // not be silently treated as free.
    if (/NON_JSON_200_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json, but still a real 200 the provider will bill for');
      return;
    }

    // Test hook: a streaming response that sends message_start (with real usage) and then
    // the connection dies mid-flight, before message_stop — no clean end() ever happens.
    if (/MID_STREAM_CUTOFF_MARKER/.test(JSON.stringify(body.system ?? ''))) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_cutoff', usage: { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
      }) + '\n\n');
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'partial' } }) + '\n\n');
      setImmediate(() => req.socket.destroy());
      return;
    }

    // Test hook: when the user prompt is "mark for bash test", return a Bash tool_use
    // block with is_background: true. The shim's response sanitizer must override it to
    // false because the command "ls -la" has no background syntax.
    const lastUserText = (() => {
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') {
        const c = msgs[i].content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map(b => b?.text || '').join(' ');
      }
      return '';
    })();
    const wantsBashTest = lastUserText.trim() === 'mark for bash test';
    // Regression hook: the command STRING VALUE itself contains the literal text
    // `"is_background":true` (as if the agent were writing a JSON file). The old streaming
    // sanitizer did a raw text-level regex replace over the whole accumulated tool_use JSON,
    // which would have mangled this occurrence too, even though it's inside a string value,
    // not the actual is_background key.
    const wantsBashCorruptionTest = lastUserText.trim() === 'mark for bash corruption test';

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: ' + JSON.stringify({
        type: 'message_start',
        message: { id: 'msg_1', usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 1 } },
      }) + '\n\n');
      if (wantsBashTest) {
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: {} },
        }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"ls -la","is_background":true}' },
        }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } }) + '\n\n');
      } else if (wantsBashCorruptionTest) {
        const cmd = 'echo \'{"is_background":true}\' > /tmp/config.json';
        const inputJson = JSON.stringify({ command: cmd, is_background: true });
        res.write('event: content_block_start\ndata: ' + JSON.stringify({
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_bash2', name: 'Bash', input: {} },
        }) + '\n\n');
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({
          type: 'content_block_delta', index: 0,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        }) + '\n\n');
        res.write('event: content_block_stop\ndata: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 10 } }) + '\n\n');
      } else {
        res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', delta: { text: 'ok' } }) + '\n\n');
        res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', usage: { output_tokens: 250 } }) + '\n\n');
      }
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (wantsBashTest) {
        res.end(JSON.stringify({
          id: 'msg_bash', type: 'message', role: 'assistant',
          content: [{
            type: 'tool_use', id: 'toolu_bash', name: 'Bash',
            input: { command: 'ls -la', is_background: true },
          }],
          stop_reason: 'tool_use', stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 10 },
        }));
      } else {
        res.end(JSON.stringify({
          id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1000, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, output_tokens: 250 },
        }));
      }
    }
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

// ------------------------------------------------------------ mock vision model
let visionCalls = 0;
const visionMock = http.createServer((req, res) => {
  let b = '';
  req.on('data', d => { b += d; });
  req.on('end', () => {
    visionCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'A red Submit button clipped at the right edge of a 280px card.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 240 },
    }));
  });
});
await new Promise(r => visionMock.listen(VISION_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------------- shim
const shim = spawn(process.execPath, [path.join(import.meta.dirname, 'shim.mjs')], {
  env: { ...process.env, DSV4F_CONFIG_DIR: CONFIG_DIR, DSV4F_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let shimLog = '';
shim.stdout.on('data', d => { shimLog += d; });
shim.stderr.on('data', d => { shimLog += d; });

// Never leave an orphaned shim holding the test port if an assertion throws.
const cleanup = () => { try { shim.kill("SIGKILL"); } catch {} try { mock.close(); } catch {} try { visionMock.close(); } catch {} };
process.on('exit', cleanup);
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); cleanup(); process.exit(1); });

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4f/health`);
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}
if (!await waitUp()) { console.error('shim failed to start:\n' + shimLog); process.exit(1); }

// --------------------------------------------------------------------- helpers
let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  -> ${detail}` : ''}`); fail++; }
}

async function send(body, { sentinel = SENTINEL } = {}) {
  const r = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${sentinel}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, last: seen[seen.length - 1] };
}

const msg = (extra = {}, text = 'hi') => ({
  model: 'deepseek-v4-flash', max_tokens: 100,
  messages: [{ role: 'user', content: text }], ...extra,
});

console.log('\n\x1b[1mclaude-dsv4f shim tests\x1b[0m\n');
console.log('\x1b[1meffort translation\x1b[0m');

let r = await send(msg());
check('main slot defaults to high', r.last?.body?.output_config?.effort === 'high', JSON.stringify(r.last?.body?.output_config));

r = await send(msg({ output_config: { effort: 'xhigh' } }));
check('ULTRACODE: xhigh -> max', r.last?.body?.output_config?.effort === 'max', JSON.stringify(r.last?.body?.output_config));

// medium is a real level upstream (measured enum: low|medium|high|xhigh|ultra|max),
// so it passes through rather than being rounded up to high.
r = await send(msg({ output_config: { effort: 'medium' } }));
check('medium -> medium (real upstream level)', r.last?.body?.output_config?.effort === 'medium', JSON.stringify(r.last?.body?.output_config));

r = await send(msg({ output_config: { effort: 'low' } }));
check('low -> low', r.last?.body?.output_config?.effort === 'low');

// There is NO `none` in the upstream effort enum — sending it returns 400. Thinking must be
// switched off with thinking:{type:"disabled"} and the effort field omitted entirely.
r = await send({ ...msg(), model: 'deepseek-v4-flash-bg' });
check('background slot disables thinking', r.last?.body?.thinking?.type === 'disabled',
  JSON.stringify(r.last?.body?.thinking));
check('background slot sends NO effort field (none would 400)',
  r.last?.body?.output_config === undefined && r.last?.body?.reasoning === undefined,
  JSON.stringify(r.last?.body?.output_config));

r = await send({ ...msg(), model: 'deepseek-v4-flash-sub' });
check('subagent slot -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));

// Ultracode promotion of subagents must be scoped to the session that asked for it.
await send(msg({ output_config: { effort: 'xhigh' }, metadata: { user_id: 'sess-A' } }));
r = await send({ ...msg({ metadata: { user_id: 'sess-A' } }), model: 'deepseek-v4-flash-sub' });
check('ultracode promotes ITS OWN session subagents -> max', r.last?.body?.output_config?.effort === 'max');
r = await send({ ...msg({ metadata: { user_id: 'sess-B' } }), model: 'deepseek-v4-flash-sub' });
check('other sessions unaffected -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));
r = await send({ ...msg(), model: 'deepseek-v4-flash-sub' });
check('unidentified session never promoted -> high', r.last?.body?.output_config?.effort === 'high',
  JSON.stringify(r.last?.body?.output_config));

r = await send(msg({}, 'please ultrathink about this one'));
check('ultrathink keyword -> max', r.last?.body?.output_config?.effort === 'max');

// An automatic guess escalates to ultra, not max: measured, max costs ~39% more wall-clock
// for ~35% more reasoning, which is only worth it when explicitly asked for.
const hardPrompt = 'Investigate the root cause of this intermittent race condition. '.repeat(20);
r = await send(msg({}, hardPrompt));
check('heuristic escalates hard task -> ultra', r.last?.body?.output_config?.effort === 'ultra',
  JSON.stringify(r.last?.body?.output_config));

// A deliberately chosen level must never be escalated by a guess — otherwise picking `low`
// to save money would spend more on exactly the prompts that look hard.
r = await send(msg({ output_config: { effort: 'low' } }, hardPrompt));
check('explicit low is NOT escalated on a hard prompt', r.last?.body?.output_config?.effort === 'low',
  JSON.stringify(r.last?.body?.output_config));
r = await send(msg({ output_config: { effort: 'medium' } }, hardPrompt));
check('explicit medium is NOT escalated', r.last?.body?.output_config?.effort === 'medium',
  JSON.stringify(r.last?.body?.output_config));
// ...but ultrathink is explicit intent and overrides a pinned level.
r = await send(msg({ output_config: { effort: 'low' } }, 'ultrathink about this'));
check('ultrathink overrides a pinned low -> max', r.last?.body?.output_config?.effort === 'max',
  JSON.stringify(r.last?.body?.output_config));

r = await send(msg({}, 'ok thanks'));
check('short simple turn stays high', r.last?.body?.output_config?.effort === 'high');

console.log('\n\x1b[1mmodel allowlist\x1b[0m');
const before = seen.length;
r = await send({ ...msg(), model: 'deepseek-v4-pro' });
check('deepseek-v4-pro refused with 403', r.status === 403, `status=${r.status}`);
check('pro request never reached upstream', seen.length === before);
check('refusal explains why', /refuses model/.test(r.text));

r = await send({ ...msg(), model: 'claude-opus-4-5' });
check('claude-* remapped to deepseek-v4-flash', r.last?.body?.model === 'deepseek-v4-flash');

console.log('\n\x1b[1mrequest hygiene\x1b[0m');
r = await send(msg({
  metadata: { user_id: 'user-123' },
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
  thinking: { type: 'adaptive' },
}));
check('metadata.user_id stripped (protects KV cache)', r.last?.body?.metadata?.user_id === undefined);
check('cache_control stripped', r.last?.body?.system?.[0]?.cache_control === undefined);
check('thinking:adaptive suppressed', r.last?.body?.thinking === undefined || r.last?.body?.thinking?.type !== 'adaptive');
check('real key injected upstream', r.last?.auth === 'Bearer sk-test-key');

r = await send(msg({ max_tokens: 999999 }));
check('max_tokens clamped to 384k', r.last?.body?.max_tokens === 384000, String(r.last?.body?.max_tokens));

console.log('\n\x1b[1mauth\x1b[0m');
r = await send(msg(), { sentinel: 'wrong-token' });
check('bad sentinel rejected with 401', r.status === 401);

console.log('\n\x1b[1mstreaming + ledger\x1b[0m');
const sres = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(msg({ stream: true })),
});
const stext = await sres.text();
check('stream passed through intact', stext.includes('message_start') && stext.includes('message_stop'));
await new Promise(r => setTimeout(r, 300));

const ledger = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const streamRow = ledger.filter(r => r.streaming).pop();
check('ledger recorded streaming request', !!streamRow);
check('captured input tokens from message_start', streamRow?.inputTokens === 1000, String(streamRow?.inputTokens));
check('captured output tokens from message_delta', streamRow?.outputTokens === 250, String(streamRow?.outputTokens));
check('captured cache read tokens', streamRow?.cacheReadTokens === 4000, String(streamRow?.cacheReadTokens));
check('cost is exact when cache split present', streamRow?.exact === true);

// 1000 miss + 0 create @0.14/M + 4000 hit @0.0028/M + 250 out @0.28/M
const expected = (1000 / 1e6) * 0.14 + (4000 / 1e6) * 0.0028 + (250 / 1e6) * 0.28;
check('cost priced correctly', Math.abs(streamRow.costUsd - expected) < 1e-9,
  `got ${streamRow?.costUsd} want ${expected}`);

// Regression: a 200 response upstream is always billed, even when its body isn't JSON
// (previously swallowed by `catch { /* ignore */ }` with no record() call at all — an
// undercounted-spend gap in the daily cap). The shim must record a best-effort estimate
// instead of treating it as free.
const nonJsonReq = {
  model: 'deepseek-v4-flash', max_tokens: 100,
  system: 'NON_JSON_200_MARKER', messages: [{ role: 'user', content: 'hi' }],
};
const nonJsonResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(nonJsonReq),
});
await new Promise(r => setTimeout(r, 100));
const ledgerAfterNonJson = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const nonJsonRow = ledgerAfterNonJson[ledgerAfterNonJson.length - 1];
check('non-JSON 200 still reaches the client', nonJsonResp.status === 200);
check('non-JSON 200 is recorded (not silently free)', nonJsonRow?.estimated === true && nonJsonRow.costUsdMax > 0,
  JSON.stringify(nonJsonRow));

// Regression: a stream that dies mid-flight (after headers/message_start, before
// message_stop) used to end the client connection with no error event and no record() call
// — invisible both to the client's stream parser and to the spend ledger. The shim must
// emit a terminal SSE error event and record whatever usage was sniffed before the cut.
const cutoffReq = {
  model: 'deepseek-v4-flash', max_tokens: 100, stream: true,
  system: 'MID_STREAM_CUTOFF_MARKER', messages: [{ role: 'user', content: 'hi' }],
};
const cutoffResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(cutoffReq),
});
const cutoffText = await cutoffResp.text();
await new Promise(r => setTimeout(r, 100));
const ledgerAfterCutoff = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
const cutoffRow = ledgerAfterCutoff[ledgerAfterCutoff.length - 1];
check('mid-stream cutoff: client receives a terminal SSE error event, not a silent hang',
  cutoffText.includes('event: error'), cutoffText.slice(0, 200));
check('mid-stream cutoff: usage sniffed before the cut is still recorded',
  cutoffRow?.inputTokens === 300, JSON.stringify(cutoffRow));

console.log('\n\x1b[1mspend cap\x1b[0m');
fs.writeFileSync(path.join(CONFIG_DIR, 'cap'), '0.00000001');
r = await send(msg());
check('cap refuses with 403 (not 429, which would retry-spin)', r.status === 403, `status=${r.status}`);
check('cap message tells you how to raise it', /dsv4f-cap/.test(r.text));
fs.writeFileSync(path.join(CONFIG_DIR, 'cap'), '5');
r = await send(msg());
check('raising the cap restores service', r.status === 200);

console.log('\n\x1b[1mmulti-byte integrity\x1b[0m');
// Chunked bodies must be decoded once, not per chunk: a UTF-8 character split across a chunk
// boundary would otherwise be corrupted. Source files with emoji or smart quotes hit this.
const unicode = 'café — “smart quotes” 日本語 🚀 ' + 'π'.repeat(40000);
r = await send(msg({}, unicode));
const roundTripped = r.last?.body?.messages?.[0]?.content;
check('multi-byte text survives a chunked body intact', roundTripped === unicode,
  `len sent=${unicode.length} got=${String(roundTripped).length}`);
check('no replacement characters introduced', !String(roundTripped).includes('�'));

console.log('\n\x1b[1munguarded paths\x1b[0m');
// Only /v1/messages is metered. Any other inference path forwarded verbatim would bill the
// real key while being invisible to the cap, the ledger and dsv4f-usage.
for (const p of ['/v1/messages/', '/v1/messages/batches', '/v1/complete']) {
  const rr = await fetch(`http://127.0.0.1:${SHIM_PORT}${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
    body: '{}',
  });
  check(`unmetered path ${p} refused`, rr.status === 404, `status=${rr.status}`);
}

console.log('\n\x1b[1mvision routing\x1b[0m');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imgMsg = (data = PNG) => ({
  model: 'deepseek-v4-flash', max_tokens: 100,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'why is this button broken?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] }],
});

const callsBefore = visionCalls;
r = await send(imgMsg());
const sent = JSON.stringify(r.last?.body);
check('image block removed before reaching DeepSeek', !sent.includes('"type":"image"'), sent.slice(0, 120));
check('description substituted as text', /Submit button clipped/.test(sent));
check('substitution is labelled as a transcription', /transcribed by/.test(sent));
check('vision model was called once', visionCalls === callsBefore + 1, `calls=${visionCalls - callsBefore}`);

const callsAfterFirst = visionCalls;
r = await send(imgMsg());
check('identical image served from cache (no second vision call)', visionCalls === callsAfterFirst,
  `extra calls=${visionCalls - callsAfterFirst}`);
check('cached description is byte-identical (protects prefix cache)',
  JSON.stringify(r.last?.body).includes('Submit button clipped'));

const callsBeforeNew = visionCalls;
r = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='));
check('a different image does trigger a new vision call', visionCalls === callsBeforeNew + 1);

// The common case in practice: the Read tool returns the image nested inside a tool_result,
// not at the top level of msg.content. Missing this depth lets images reach DeepSeek untouched.
const callsBeforeNested = visionCalls;
r = await send({
  model: 'deepseek-v4-flash', max_tokens: 100,
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x.png' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA3fzQuwAAAABJRU5ErkJggg==' } },
    ] }] },
  ],
});
const nestedSent = JSON.stringify(r.last?.body);
check('image nested in tool_result is intercepted', visionCalls === callsBeforeNested + 1,
  `calls=${visionCalls - callsBeforeNested}`);
check('no image block survives inside tool_result', !nestedSent.includes('"type":"image"'),
  nestedSent.slice(0, 140));
check('nested description reaches DeepSeek', /Submit button clipped/.test(nestedSent));

const callsBeforeText = visionCalls;
r = await send(msg());
check('text-only request never touches the vision model', visionCalls === callsBeforeText);

// --- agent-directed focus ---------------------------------------------------------------
// The agent states what it needs before reading the image; that text steers the transcription.
let lastVisionBody = null;
visionMock.removeAllListeners('request');
visionMock.on('request', (req, res) => {
  let b = '';
  req.on('data', d => { b += d; });
  req.on('end', () => {
    visionCalls++;
    try { lastVisionBody = JSON.parse(b); } catch { lastVisionBody = null; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'A red Submit button clipped at the right edge of a 280px card.' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 240 },
    }));
  });
});

const focusImg = (data, saidBefore) => ({
  model: 'deepseek-v4-flash', max_tokens: 100,
  messages: [
    { role: 'assistant', content: [
      { type: 'text', text: saidBefore },
      { type: 'tool_use', id: 'tu9', name: 'Read', input: { file_path: '/shot.png' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
    ] }] },
  ],
});

const F1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
await send(focusImg(F1, 'VISION: exact pixel positions and z-order of every sprite on the canvas'));
const askText = JSON.stringify(lastVisionBody?.messages?.[1]?.content?.[0]?.text || '');
check('explicit VISION: marker reaches the vision model', /z-order of every sprite/.test(askText), askText.slice(0, 140));
check('focus supplements rather than replaces the full description',
  /describe the whole image completely/i.test(askText));

const F2 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAgH/JsUiUwAAAABJRU5ErkJggg==';
await send(focusImg(F2, 'Let me check whether the health bar overlaps the minimap.'));
const askText2 = JSON.stringify(lastVisionBody?.messages?.[1]?.content?.[0]?.text || '');
check('plain stated intent is used as focus when no marker', /health bar overlaps the minimap/.test(askText2),
  askText2.slice(0, 140));

// Focus is part of the cache key, but the SAME history must still replay from cache — otherwise
// the description would change between turns and break the upstream prompt-prefix cache.
const beforeReplay = visionCalls;
await send(focusImg(F1, 'VISION: exact pixel positions and z-order of every sprite on the canvas'));
check('same image + same focus replays from cache', visionCalls === beforeReplay,
  `extra calls=${visionCalls - beforeReplay}`);

const beforeDiff = visionCalls;
await send(focusImg(F1, 'VISION: read the score counter in the top right'));
check('different focus on same image is a distinct cache entry', visionCalls === beforeDiff + 1);

// Regression: two concurrent requests carrying the identical (never-before-seen) image both
// used to miss the cache and each pay for their own vision call — routine with parallel
// subagents re-sending the same screenshot before either's description is cached yet.
const F3 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPjPwAAEDAIA/isKoAAAAABJRU5ErkJggg==';
const beforeConcurrent = visionCalls;
await Promise.all([send(imgMsg(F3)), send(imgMsg(F3))]);
check('concurrent requests for the same never-seen image share one in-flight vision call',
  visionCalls === beforeConcurrent + 1, `extra calls=${visionCalls - beforeConcurrent}`);

r = await send(msg({ system: 'You are a coding agent.' }));
check('hint appended to a string system prompt',
  /VISION: <what to look for>/.test(String(r.last?.body?.system || '')), String(r.last?.body?.system).slice(0, 120));

r = await send(msg({ system: [{ type: 'text', text: 'You are a coding agent.' }] }));
check('hint appended to a block-array system prompt',
  /VISION: <what to look for>/.test(JSON.stringify(r.last?.body?.system || '')));

// Appending must be idempotent, or the prompt prefix would grow on every turn and never cache.
const twice = await send(msg({ system: String(r.last?.body?.system?.[0]?.text || '') }));
const hintCount = (String(twice.last?.body?.system || '').match(/VISION: <what to look for>/g) || []).length;
check('hint is not appended twice (prefix stays stable)', hintCount === 1, `count=${hintCount}`);

// Vision has its own cap against a separate provider and credit pool.
fs.writeFileSync(path.join(CONFIG_DIR, 'vision-cap'), '0.0000001');
const callsAtCap = visionCalls;
r = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAgH/q842iQAAAABJRU5ErkJggg=='));
const capSent = JSON.stringify(r.last?.body);
check('vision cap blocks NEW descriptions', visionCalls === callsAtCap, `extra calls=${visionCalls - callsAtCap}`);
check('capped image degrades to a clear note, not an error', r.status === 200 && /vision spending cap reached/.test(capSent), capSent.slice(0, 160));
// Regression: the placeholder text must be the same fixed phrase every time the SAME failure
// class recurs — not the live "spent ~$X.XXXX" figure — or DeepSeek's prompt-prefix cache
// gets busted on every single turn for as long as the cap stays hit. Failures are never
// written to the persistent cache, so this second call re-hits the live cap check exactly
// like the first did.
const secondCapped = await send(imgMsg('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAgH/q842iQAAAABJRU5ErkJggg=='));
const extractPlaceholder = (body) => {
  const m = String(body).match(/description unavailable[^"]*/);
  return m?.[0];
};
check('capped placeholder text is byte-stable across repeats (preserves the prompt-prefix cache)',
  extractPlaceholder(capSent) === extractPlaceholder(JSON.stringify(secondCapped.last?.body)),
  `${extractPlaceholder(capSent)} vs ${extractPlaceholder(JSON.stringify(secondCapped.last?.body))}`);
check('coding request still succeeds when vision is capped', r.status === 200);
// A cached image costs nothing, so it must keep working past the cap.
r = await send(imgMsg());
check('cached images still served past the cap', JSON.stringify(r.last?.body).includes('Submit button clipped'));
fs.writeFileSync(path.join(CONFIG_DIR, 'vision-cap'), '1.5');

const vrow = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l)).filter(x => x.slot === 'vision');
check('vision calls logged separately in the ledger', vrow.length >= 1, `rows=${vrow.length}`);
check('vision cost attributed to deepinfra', vrow[0]?.provider === 'deepinfra');

// Providers share one ledger, so every row must declare its provider — otherwise DeepInfra
// dollars are charged against the DeepSeek cap AND the vision cap, i.e. billed twice.
const allRows = fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8')
  .split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
check('every ledger row declares a provider', allRows.every(r => r.provider === 'deepseek' || r.provider === 'deepinfra'),
  `missing on ${allRows.filter(r => !r.provider).length} rows`);

const liveSummary = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4f/usage`, {
  headers: { authorization: `Bearer ${SENTINEL}` },
})).json();
const dsLedger = allRows.filter(r => (r.provider || 'deepseek') === 'deepseek')
  .reduce((s, r) => s + (r.costUsdMax ?? r.costUsd ?? 0), 0);
const diLedger = allRows.filter(r => r.provider === 'deepinfra')
  .reduce((s, r) => s + (r.costUsdMax ?? r.costUsd ?? 0), 0);
check("DeepSeek spend excludes vision cost", Math.abs(liveSummary.todayUsd - dsLedger) < 1e-6,   // summary rounds to 6dp
  `reported=${liveSummary.todayUsd} deepseek-only=${dsLedger}`);
check("vision spend tracked against its own provider", Math.abs(liveSummary.vision.spentUsd - diLedger) < 1e-6,
  `reported=${liveSummary.vision.spentUsd} deepinfra-only=${diLedger}`);
check('the two provider totals do not overlap', diLedger > 0 && liveSummary.todayUsd !== liveSummary.vision.spentUsd);

console.log('\n\x1b[1musage endpoint\x1b[0m');
// The usage summary embeds the DeepSeek account balance, so it must not be readable without
// the sentinel, and a rebound Host must not reach it either.
const unauth = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4f/usage`);
check('usage endpoint requires the sentinel', unauth.status === 401, `status=${unauth.status}`);
const health = await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4f/health`);
const healthBody = await health.json();
check('health stays open for the readiness probe', health.status === 200 && healthBody.ok === true);
check('health leaks no spend, balance or config', !('model' in healthBody) && !('capUsd' in healthBody),
  JSON.stringify(healthBody));
// fetch() treats Host as a forbidden header and drops it, so this needs a raw request.
const reboundStatus = await new Promise((resolve) => {
  const rq = http.request({
    host: '127.0.0.1', port: SHIM_PORT, path: '/_dsv4f/health', method: 'GET',
    headers: { host: 'evil.example.com' },
  }, (rs) => { rs.resume(); resolve(rs.statusCode); });
  rq.on('error', () => resolve(0));
  rq.end();
});
check('foreign Host header rejected (DNS rebinding)', reboundStatus === 403, `status=${reboundStatus}`);

const u = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/_dsv4f/usage`, {
  headers: { authorization: `Bearer ${SENTINEL}` },
})).json();
check('reports request count', u.requests > 0);
check('reports burn rate', typeof u.burn?.tokensPerMin === 'number');
check('reports cap', u.capUsd === 5);

// ----------------------------------------------------------------- new sub-routines

// --- classifier interceptor ---
// Both `classify_result` (tool name) and `shouldBlock` (its only parameter) must appear.
// The mock upstream records every body it sees in `seen`; we verify that NO such body
// arrived there (i.e. the shim short-circuited the request).
const beforeClassifier = seen.length;
const classReq = {
  model: 'deepseek-v4-flash',
  system: 'You are the safety classifier. Use classify_result and return shouldBlock.',
  tools: [{ name: 'classify_result', description: 'classify safety', input_schema: { properties: { shouldBlock: {} } } }],
  messages: [{ role: 'user', content: 'ls -la' }],
};
const classResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(classReq),
});
const classBody = await classResp.json();
check('classifier mock returns 200', classResp.status === 200);
check('classifier mock tool_use is classify_result',
  classBody.content?.[0]?.name === 'classify_result');
check('classifier mock shouldBlock is false',
  classBody.content?.[0]?.input?.shouldBlock === false);
check('classifier mock was NOT forwarded to upstream',
  seen.length === beforeClassifier);

// Regression: a real bug found live on 2026-08-10. The matcher used to be a substring search
// over the WHOLE stringified body, which includes the entire resent conversation history —
// not just the current turn. A session that had ever discussed "classify_result" and
// "shouldBlock" in plain text (e.g. debugging this exact file) matched on EVERY subsequent
// request for the rest of that conversation, hijacking real replies with the canned mock.
// Confirmed on this box: one resumed session's history alone contained "classify_result"
// 11,315 times, and every one of its ~34,000 requests over the following day was intercepted.
// A normal coding turn whose HISTORY merely mentions both words as text (no actual
// classify_result tool defined on the CURRENT request) must be forwarded normally.
const beforePolluted = seen.length;
const pollutedReq = {
  model: 'deepseek-v4-flash',
  system: 'You are Claude Code.',
  messages: [
    { role: 'user', content: 'how does the shim\'s classify_result / shouldBlock interceptor work?' },
    { role: 'assistant', content: 'It matches on classify_result (tool name) and shouldBlock (its parameter)...' },
    { role: 'user', content: 'ok now fix the bug we just found in shouldBlock handling' },
  ],
  // No classify_result tool defined on THIS request — a real coding turn's toolset.
  tools: [{ name: 'Bash', description: 'run a shell command', input_schema: { properties: { command: {} } } }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(pollutedReq),
});
check('a real turn whose HISTORY mentions classify_result/shouldBlock as text is NOT hijacked',
  seen.length === beforePolluted + 1, `forwarded=${seen.length - beforePolluted}`);

// --- classifier V2: retry-with-backoff on a stalled/reset upstream connection ---
// This is the incident the shim previously had no defense against: auto-mode's two-stage
// XML classifier runs against Claude Code's own ~60s fail-closed budget, and a single
// stalled DeepSeek connection used to surface straight through as a 502 (the harness then
// denies the tool call, "temporarily unavailable"). The mock fails the first two attempts
// outright (destroyed connection, no response) and succeeds on the third; the shim must
// retry transparently and the client must see a normal 200, not an error.
const retryBefore = seen.length;
const retryReq = {
  model: 'deepseek-v4-flash', max_tokens: 100,
  system: 'permission classifier decision RETRY_TEST_MARKER',
  messages: [{ role: 'user', content: 'rm -rf /tmp/x' }],
};
const retryResp = await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(retryReq),
});
check('classifier V2: transient upstream failures are retried transparently (200, not 502)',
  retryResp.status === 200, `got ${retryResp.status}`);
check('classifier V2: exactly 3 upstream attempts were made (2 failures + 1 success)',
  seen.length === retryBefore + 3, `got ${seen.length - retryBefore}`);

// --- environment sanitizer ---
// Send a request whose system contains is_background: true and degraded_mode: true;
// the shim must rewrite them to false BEFORE forwarding to upstream.
const envReq = {
  model: 'deepseek-v4-flash',
  system: 'You are Claude Code.\n<environment_context>\n  is_background: true\n  degraded_mode: true\n</environment_context>',
  messages: [{ role: 'user', content: 'hi' }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(envReq),
});
const envSeen = seen[seen.length - 1].body;
check('env sanitizer: is_background rewritten to false upstream',
  !envSeen.system.includes('is_background: true') && envSeen.system.includes('is_background: false'));
check('env sanitizer: degraded_mode rewritten to false upstream',
  !envSeen.system.includes('degraded_mode: true') && envSeen.system.includes('degraded_mode: false'));

// --- model mapper ---
// claude-3-5-haiku must be rewritten to the configured DeepSeek model BEFORE forwarding.
const beforeMapping = seen.length;
const mappedReq = {
  model: 'claude-3-5-haiku-20241022',
  system: 'topic detection', messages: [{ role: 'user', content: 'name the window' }],
};
await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(mappedReq),
});
check('model mapper: claude-3-5-haiku forwarded as deepseek-* to upstream',
  seen.length === beforeMapping + 1 &&
  /deepseek/i.test(seen[seen.length - 1].body.model) &&
  !/claude-3-5-haiku/.test(seen[seen.length - 1].body.model));

// Regression: cfg.fastModel used to be undefined, so modelMapper fell through to cfg.model
// (the real "deepseek-v4-flash" string) — which resolveModel() then slots as "main" (its own
// sentinel), landing haiku/background/compaction traffic on effort:high instead of
// effort:none. That is a ~25-50x cost inflation for traffic that never needed to think at
// all. Correct behavior: mapped requests carry thinking:disabled (the shim's effort:none
// encoding), proving they landed on the background slot.
check('model mapper: haiku traffic lands on background slot (effort:none), not main:high',
  seen[seen.length - 1].body.thinking?.type === 'disabled');

// Allowlist design (2026-08-13): current flagships -> main; EVERYTHING else Anthropic-shaped
// (any Haiku generation, any non-current Sonnet/Opus/Fable generation, any future unlisted
// name) -> background. This is the actual behavior change from the old blocklist approach —
// claude-3-5-sonnet/claude-3-opus used to map to main, now correctly default to background
// since they aren't current flagships.
r = await send({ ...msg(), model: 'claude-opus-5-20251101' });
check('model mapper: current flagship (opus-5) -> main (effort:high, thinking enabled)',
  r.last?.body?.output_config?.effort === 'high' && r.last?.body?.thinking?.type !== 'disabled',
  JSON.stringify({ output_config: r.last?.body?.output_config, thinking: r.last?.body?.thinking }));

r = await send({ ...msg(), model: 'claude-sonnet-5-20251101' });
check('model mapper: current flagship (sonnet-5) -> main', r.last?.body?.output_config?.effort === 'high');

r = await send({ ...msg(), model: 'claude-3-5-sonnet-20241022' });
check('model mapper: non-current sonnet (3-5) -> background, NOT main (was the old behavior)',
  r.last?.body?.thinking?.type === 'disabled', JSON.stringify(r.last?.body?.thinking));

r = await send({ ...msg(), model: 'claude-3-opus-20240229' });
check('model mapper: non-current opus (3) -> background, NOT main (was the old behavior)',
  r.last?.body?.thinking?.type === 'disabled', JSON.stringify(r.last?.body?.thinking));

r = await send({ ...msg(), model: 'claude-sonnet-9-hypothetical-future-model' });
check('model mapper: unlisted future generation defaults safely to background, not main',
  r.last?.body?.thinking?.type === 'disabled', JSON.stringify(r.last?.body?.thinking));

// --- response sanitizer (Bash tool_use with is_background: true) ---
// The mock upstream returns a Bash tool_use block with is_background: true when the user
// prompt is exactly 'mark for bash test'. The shim must rewrite is_background to false
// because the command `ls -la` has no background syntax.
const bashReq = {
  model: 'deepseek-v4-flash',
  system: 'x',
  messages: [{ role: 'user', content: 'mark for bash test' }],
};
const bashResp = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(bashReq),
})).json();
const bashTool = bashResp.content?.find(b => b.type === 'tool_use' && b.name === 'Bash');
check('response sanitizer: Bash is_background forced false when no bg syntax',
  bashTool && bashTool.input.is_background === false);

// Streaming variant: same request with stream:true — sanitizer must also rewrite the
// streamed content_block events. The mock's partial_json is double-JSON-encoded in the
// SSE payload (the chunk is itself a JSON string), so we look for the JSON-escaped form
// `is_background\":true|false`.
const bashStreamReq = { ...bashReq, stream: true };
const bashStreamBody = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(bashStreamReq),
})).text();
const streamHasTrue = /is_background\\":\s*true/.test(bashStreamBody);
const streamHasFalse = /is_background\\":\s*false/.test(bashStreamBody);
const streamOk = !streamHasTrue && streamHasFalse;
check('response sanitizer: streaming Bash is_background rewritten', streamOk,
  streamOk ? '' : `body:\n${bashStreamBody}`);

// Regression: a Bash command whose own text contains `"is_background":true` must not have
// that occurrence mangled by the sanitizer — only the actual is_background key changes.
const corruptionReq = { model: 'deepseek-v4-flash', system: 'x', stream: true,
  messages: [{ role: 'user', content: 'mark for bash corruption test' }] };
const corruptionBody = await (await fetch(`http://127.0.0.1:${SHIM_PORT}/v1/messages`, {
  method: 'POST', headers: { authorization: `Bearer ${SENTINEL}`, 'content-type': 'application/json' },
  body: JSON.stringify(corruptionReq),
})).text();
const jsonLine = corruptionBody.split('\n').find(l => l.startsWith('data:') && l.includes('input_json_delta'));
const parsedInput = jsonLine ? JSON.parse(JSON.parse(jsonLine.slice(5)).delta.partial_json) : null;
check('response sanitizer: is_background key rewritten to false',
  parsedInput?.is_background === false, JSON.stringify(parsedInput));
check('response sanitizer: literal "is_background":true INSIDE the command string survives untouched',
  parsedInput?.command === 'echo \'{"is_background":true}\' > /tmp/config.json', parsedInput?.command);

console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m\n`);
if (fail) console.log('shim log:\n' + shimLog);

shim.kill(); mock.close(); visionMock.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
