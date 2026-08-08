#!/usr/bin/env node
/**
 * claude-dsv4f Phase 0 probe.
 *
 * The official DeepSeek docs contradict each other in two places that matter, and are silent
 * on a third:
 *   - the thinking-mode guide calls the Anthropic-format effort field `reasoning`,
 *     while the anthropic_api page calls it `output_config`;
 *   - the API reference nests reasoning_effort under `thinking`, the guide passes it top level;
 *   - the Anthropic-format `usage` object is undocumented entirely (no response section).
 *
 * Rather than pick a side, measure. Results land in probe-results.json and the shim reads
 * them at startup. Total cost is a few cents.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';

const HOME = os.homedir();
const CONFIG_DIR = process.env.DSV4F_CONFIG_DIR || path.join(HOME, '.config', 'claude-dsv4f');
const KEY_FILE = path.join(CONFIG_DIR, 'key');
const OUT_FILE = path.join(CONFIG_DIR, 'probe-results.json');

const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
if (!KEY) { console.error('No API key found. Run claude-dsv4f-setup first.'); process.exit(1); }

const ANTHROPIC = 'https://api.deepseek.com/anthropic/v1';
const MODEL = 'deepseek-v4-flash';

function req(url, { method = 'POST', body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const r = https.request(url, {
      method,
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
        ...(data ? { 'content-length': data.length } : {}),
        ...headers,
      },
      timeout: 180000,
    }, (res) => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch { /* leave null */ }
        resolve({ status: res.statusCode, json, text: b });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, text: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

const msg = (extra = {}, text = 'Reply with the single word: ok') => ({
  model: MODEL,
  max_tokens: 64,
  messages: [{ role: 'user', content: text }],
  ...extra,
});

function errMsg(r) {
  return (r.json?.error?.message || r.json?.message || r.text || '').slice(0, 200);
}

const results = { probedAt: new Date().toISOString(), probes: {} };
function note(name, ok, detail) {
  results.probes[name] = { ok, ...detail };
  const mark = ok === true ? '✓' : ok === false ? '✗' : '?';
  console.log(`  ${mark} ${name}: ${detail.summary}`);
}

const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(220); // ~2k tokens

(async () => {
  console.log('\nclaude-dsv4f probe — measuring actual endpoint behaviour\n');

  // 1. model list -------------------------------------------------------------
  const models = await req('https://api.deepseek.com/models', { method: 'GET' });
  const ids = (models.json?.data || []).map(m => m.id);
  const hasFlash = ids.includes(MODEL);
  results.availableModels = ids;
  note('models', hasFlash, {
    summary: hasFlash ? `${MODEL} available (all: ${ids.join(', ') || 'none listed'})`
                      : `${MODEL} NOT in model list! got: ${ids.join(', ') || models.text.slice(0, 120)}`,
  });

  // 2. baseline: what does the Anthropic-format usage object actually contain? -
  const base = await req(`${ANTHROPIC}/messages`, { body: msg() });
  const usage = base.json?.usage || {};
  const usageKeys = Object.keys(usage);
  const hasCache = usageKeys.some(k => /cache/i.test(k));
  results.usageKeys = usageKeys;
  results.usageSample = usage;
  results.usageHasCacheFields = hasCache;
  note('baseline', base.status === 200, {
    summary: base.status === 200
      ? `usage keys: [${usageKeys.join(', ')}]  cacheFields=${hasCache ? 'YES (exact costing)' : 'NO (bounded costing + reconcile)'}`
      : `HTTP ${base.status}: ${errMsg(base)}`,
    status: base.status, usage,
  });

  // 3./4. which effort field name is real? ------------------------------------
  const oc = await req(`${ANTHROPIC}/messages`, { body: msg({ output_config: { effort: 'max' } }) });
  note('output_config.effort', oc.status === 200, {
    summary: oc.status === 200 ? 'accepted' : `HTTP ${oc.status}: ${errMsg(oc)}`, status: oc.status,
  });

  const rs = await req(`${ANTHROPIC}/messages`, { body: msg({ reasoning: { effort: 'max' } }) });
  note('reasoning.effort', rs.status === 200, {
    summary: rs.status === 200 ? 'accepted' : `HTTP ${rs.status}: ${errMsg(rs)}`, status: rs.status,
  });

  let effortField = null;
  if (oc.status === 200) effortField = 'output_config';
  else if (rs.status === 200) effortField = 'reasoning';
  results.effortField = effortField || 'output_config';
  results.effortSupported = effortField !== null;

  const withEffort = (e) => msg({ [results.effortField]: { effort: e } });

  // 5. does xhigh 400? (this is exactly what ultracode sends) ------------------
  const xh = await req(`${ANTHROPIC}/messages`, { body: withEffort('xhigh') });
  results.xhighAccepted = xh.status === 200;
  note('effort=xhigh (ultracode)', xh.status === 200 ? true : false, {
    summary: xh.status === 200
      ? 'accepted (but not a documented DeepSeek level — still rewriting to max)'
      : `HTTP ${xh.status} — confirms the xhigh->max rewrite is REQUIRED for ultracode`,
    status: xh.status,
  });

  // 6. effort=none — expected to fail; the rejection also reveals the real enum ---
  const none = await req(`${ANTHROPIC}/messages`, { body: withEffort('none') });
  results.effortNoneAccepted = none.status === 200;
  // The 400 body enumerates the valid variants, which is more authoritative than the docs.
  const enumMatch = /expected one of ([^\n]+?) at line/.exec(errMsg(none));
  if (enumMatch) {
    results.validEffortValues = enumMatch[1].split(',').map(s => s.trim().replace(/`/g, '')).filter(Boolean);
  }
  note('effort=none rejected (expected)', none.status === 200 ? null : true, {
    summary: none.status === 200
      ? 'accepted — unexpected; docs say none exists in Anthropic format'
      : `correctly rejected; real enum = [${(results.validEffortValues || []).join(', ')}] — thinking is disabled via thinking:{type:"disabled"}`,
    status: none.status,
  });

  // 7./8. thinking field handling --------------------------------------------
  const td = await req(`${ANTHROPIC}/messages`, { body: msg({ thinking: { type: 'disabled' } }) });
  results.thinkingDisabledHonored = td.status === 200;
  note('thinking.type=disabled', td.status === 200, {
    summary: td.status === 200 ? 'accepted' : `HTTP ${td.status}: ${errMsg(td)}`, status: td.status,
  });

  const ta = await req(`${ANTHROPIC}/messages`, { body: msg({ thinking: { type: 'adaptive' } }) });
  results.thinkingAdaptiveAccepted = ta.status === 200;
  note('thinking.type=adaptive', ta.status === 200 ? null : true, {
    summary: ta.status === 200 ? 'accepted (unexpected; shim strips it anyway)'
                               : `HTTP ${ta.status} — confirms adaptive must be suppressed`,
    status: ta.status,
  });

  // 9. count_tokens -----------------------------------------------------------
  const ct = await req(`${ANTHROPIC}/messages/count_tokens`, {
    body: { model: MODEL, messages: [{ role: 'user', content: 'hello' }] },
  });
  results.countTokensSupported = ct.status === 200;
  note('count_tokens', ct.status === 200 ? true : null, {
    summary: ct.status === 200 ? 'supported' : `HTTP ${ct.status} — Claude Code will estimate locally (harmless)`,
    status: ct.status,
  });

  // 10. cache behaviour: identical long prefix twice --------------------------
  const cacheBody = () => msg({}, `${filler}\n\nReply with the single word: ok`);
  const c1 = await req(`${ANTHROPIC}/messages`, { body: cacheBody() });
  await new Promise(r => setTimeout(r, 2000));
  const c2 = await req(`${ANTHROPIC}/messages`, { body: cacheBody() });
  results.cacheProbe = { first: c1.json?.usage || null, second: c2.json?.usage || null };
  const movedCache = hasCache && JSON.stringify(c1.json?.usage) !== JSON.stringify(c2.json?.usage);
  note('prefix cache', movedCache ? true : null, {
    summary: hasCache
      ? `first=${JSON.stringify(c1.json?.usage)} second=${JSON.stringify(c2.json?.usage)}`
      : 'usage exposes no cache fields — hit ratio must be derived via dsv4f-usage --reconcile',
  });

  // 11. effort ladder — measure every level, including the undocumented `ultra`. ----
  // max_tokens must be generous or the levels truncate at the ceiling and the comparison
  // is meaningless. The note above said exactly that and the value stayed at 4,000 anyway:
  // the 2026-08-07 run recorded output_tokens=4000 for ALL SIX levels, i.e. every one of
  // them hit the cap, and the probe then reported "levels look identical" and stored
  // effortTakesEffect:false. That conclusion measured the ceiling, not the model.
  // Fixed 2026-08-08: a real budget, an explicit truncation check via stop_reason, and a
  // comparison on thinking volume — which is the thing effort actually governs — rather
  // than on output_tokens, which saturates.
  const LADDER_MAX_TOKENS = 64000;
  const q = 'A farmer must cross a river with a wolf, a goat and a cabbage. The boat holds ' +
            'the farmer plus one item. Wolf eats goat if left alone; goat eats cabbage if left ' +
            'alone. Give the full sequence of crossings and prove it is minimal.';
  const ladder = results.validEffortValues?.length
    ? results.validEffortValues
    : ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'];
  results.effortLadder = {};
  const rows = [];
  for (const lvl of ladder) {
    const t0 = Date.now();
    const rr = await req(`${ANTHROPIC}/messages`, {
      body: { model: MODEL, max_tokens: LADDER_MAX_TOKENS, messages: [{ role: 'user', content: q }], [results.effortField]: { effort: lvl } },
    });
    const u = rr.json?.usage || {};
    const thinkBlocks = (rr.json?.content || []).filter(b => b.type === 'thinking');
    const thinkChars = thinkBlocks.reduce((s, b) => s + (b.thinking || '').length, 0);
    const rec = {
      status: rr.status,
      stopReason: rr.json?.stop_reason ?? null,
      truncated: rr.json?.stop_reason === 'max_tokens',
      outputTokens: u.output_tokens ?? 0,
      inputTokens: u.input_tokens ?? 0,
      thinkingBlocks: thinkBlocks.length,
      thinkingChars: thinkChars,
      ms: Date.now() - t0,
    };
    results.effortLadder[lvl] = rec;
    rows.push(`${lvl.padEnd(7)} out=${String(rec.outputTokens).padStart(6)}  think=${String(rec.thinkingChars).padStart(7)}ch  ${String(rec.ms).padStart(6)}ms` +
              `${rec.truncated ? '  TRUNCATED' : ''}${rr.status !== 200 ? `  HTTP ${rr.status}` : ''}`);
  }
  const recs = ladder.map(l => results.effortLadder[l]).filter(r => r && r.status === 200);
  const truncated = recs.filter(r => r.truncated).length;
  // Effort governs how much the model thinks, so compare thinking volume. Output length
  // saturates against max_tokens and tells you nothing once anything has truncated.
  const think = recs.map(r => r.thinkingChars);
  const spread = think.length && Math.min(...think) > 0 ? Math.max(...think) / Math.min(...think) : 0;
  results.effortLadderTruncated = truncated;
  results.effortTakesEffect = truncated === 0 && spread > 1.15;

  let verdict;
  if (!recs.length) verdict = 'no level returned 200 — inconclusive';
  else if (truncated) {
    // Never let a capped run masquerade as a finding in either direction.
    verdict = `INCONCLUSIVE: ${truncated}/${recs.length} level(s) hit the ${LADDER_MAX_TOKENS.toLocaleString()}-token ceiling; raise LADDER_MAX_TOKENS and re-run`;
  } else if (results.effortTakesEffect) {
    verdict = `levels differ measurably (${spread.toFixed(2)}x thinking between lowest and highest)`;
  } else {
    verdict = `levels look identical (${spread.toFixed(2)}x thinking spread, no truncation) — the endpoint may be ignoring effort`;
  }
  note('effort ladder', truncated ? null : (results.effortTakesEffect ? true : null), {
    summary: verdict + '\n      ' + rows.join('\n      '),
  });

  // 12. balance ---------------------------------------------------------------
  const bal = await req('https://api.deepseek.com/user/balance', { method: 'GET' });
  results.balance = bal.json;
  const bi = bal.json?.balance_infos?.[0];
  note('balance', bal.status === 200, {
    summary: bal.status === 200
      ? `${bi?.total_balance} ${bi?.currency} available=${bal.json?.is_available}`
      : `HTTP ${bal.status}: ${errMsg(bal)}`,
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
  fs.chmodSync(OUT_FILE, 0o600);

  console.log(`\nWrote ${OUT_FILE}\n`);
  console.log('Shim will use:');
  console.log(`  effort field   : ${results.effortField}${results.effortSupported ? '' : '  (NOT SUPPORTED — falling back to thinking on/off only)'}`);
  console.log(`  cost accounting: ${results.usageHasCacheFields ? 'EXACT (cache split reported)' : 'BOUNDED (use dsv4f-usage --reconcile to calibrate)'}`);
  console.log(`  xhigh rewrite  : ${results.xhighAccepted ? 'still applied (xhigh is not a DeepSeek level)' : 'REQUIRED — ultracode would 400 without it'}`);
  console.log(`  count_tokens   : ${results.countTokensSupported ? 'proxied' : 'returns 404, Claude Code estimates locally'}\n`);
})();
