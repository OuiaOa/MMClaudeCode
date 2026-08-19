#!/usr/bin/env node
/**
 * Scores a vision model against the benchmark fixtures.
 *
 * By default it tests whatever model your mmclaude install is configured to use, so the
 * question it answers is "is MY vision setup any good", not "which model is best in the
 * abstract". Pass --model to compare alternatives before committing to one.
 *
 *   node bench.mjs                                  test the configured model
 *   node bench.mjs --model google/gemini-2.0-flash-001,Qwen/Qwen3-VL-30B-A3B-Instruct
 *   node bench.mjs --images ./my-shots              use your own images (see below)
 *   node bench.mjs --verbose                        print each answer
 *
 * BRING YOUR OWN IMAGES
 * Point --images at a directory containing your files plus a truth.json alongside them:
 *
 *   [ { "png": "receipt.jpg",
 *       "ask": "Transcribe the total and the invoice number.",
 *       "must": [ ["INV-2201"], ["48.75", "48,75"] ],
 *       "bonus": [ ["handwritten"] ] } ]
 *
 * Each entry of `must` is a list of acceptable alternatives — any one of them counts as a hit,
 * which keeps scoring fair across models that format numbers or dates differently. `bonus` is
 * recorded but not scored, for things it would be nice to notice but unfair to require.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = import.meta.dirname;
const HOME = os.homedir();
const CONFIG_DIR = process.env.MMCLAUDE_CONFIG_DIR || path.join(HOME, '.config', 'mmclaude');

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const VERBOSE = flag('--verbose');

const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
const vision = cfg.vision || {};
const ENDPOINT = val('--endpoint', vision.endpoint || 'https://api.deepinfra.com/v1/openai/chat/completions');
const KEYFILE = path.join(CONFIG_DIR, vision.keyFile || 'deepinfra-key');

let KEY = process.env.MMCLAUDE_VISION_KEY || '';
if (!KEY) { try { KEY = fs.readFileSync(KEYFILE, 'utf8').trim(); } catch { /* reported below */ } }
if (!KEY) {
  console.error(`No vision API key.\n  Expected at ${KEYFILE} — run: mmclaude key deepinfra\n  Or set MMCLAUDE_VISION_KEY.`);
  process.exit(1);
}

const MODELS = val('--model', vision.model || 'google/gemini-3.1-flash-lite').split(',').map(s => s.trim());

// ------------------------------------------------------------------- fixtures

const imgDir = val('--images', null);
const truthPath = imgDir ? path.join(imgDir, 'truth.json') : path.join(DIR, 'truth.json');
if (!fs.existsSync(truthPath)) {
  console.error(imgDir
    ? `No truth.json in ${imgDir}. See the header of this file for the format.`
    : `No fixtures yet. Run: node ${path.join(DIR, 'gen-fixtures.mjs')}`);
  process.exit(1);
}
const TESTS = JSON.parse(fs.readFileSync(truthPath, 'utf8'));
const baseDir = imgDir || DIR;

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
for (const t of TESTS) {
  const p = path.resolve(baseDir, t.png);
  if (!fs.existsSync(p)) { console.error(`missing image: ${p}`); process.exit(1); }
  t.url = `data:${MIME[path.extname(p).toLowerCase()] || 'image/png'};base64,${fs.readFileSync(p).toString('base64')}`;
  t.kb = Math.round(fs.statSync(p).size / 1024);
}

// -------------------------------------------------------------------- scoring

const norm = s => String(s).toLowerCase()
  .replace(/[£$€,]/g, '')
  .replace(/[‐-―−]/g, '-')   // dash variants
  .replace(/\s+/g, ' ');

const matches = (answer, alt) =>
  (alt && typeof alt === 'object' && alt.re)
    ? new RegExp(alt.re, alt.flags || '').test(answer)
    : answer.includes(norm(alt));

function score(text, t) {
  const a = norm(text);
  const hits = (t.must || []).map(alts => alts.some(alt => matches(a, alt)));
  const missed = (t.must || []).filter((_, i) => !hits[i]).map(alts => (alts[0]?.re ?? alts[0]));
  const bonus = t.bonus ? t.bonus.some(alts => alts.some(alt => matches(a, alt))) : null;
  // mustNot catches confident invention — e.g. supplying characters that are physically
  // covered in the image. Each violation costs a point, because a plausible fabrication is
  // worse than an admission of uncertainty when the reader cannot check.
  const invented = (t.mustNot || []).filter(alts => alts.some(alt => matches(a, alt)))
    .map(alts => (alts[0]?.re ?? alts[0]));
  return { hit: Math.max(0, hits.filter(Boolean).length - invented.length), total: hits.length, missed, bonus, invented };
}

// -------------------------------------------------------------------- running

const SYSTEM =
  'You are the eyes of a system that cannot see images. Transcribe every piece of visible text ' +
  'verbatim, preserving exact casing, punctuation and identifiers. Describe layout concretely: ' +
  'positions, sizes, alignment, what overlaps what and which is in front. Note anything unusual ' +
  'about the image itself, including its orientation. Never guess — if something is illegible, ' +
  'obscured or ambiguous, say so and say which part. Be exhaustive; completeness matters more ' +
  'than brevity.';

async function ask(model, t) {
  const t0 = Date.now();
  try {
    const r = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 2000, temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: [{ type: 'text', text: t.ask }, { type: 'image_url', image_url: { url: t.url } }] },
        ],
      }),
      signal: AbortSignal.timeout(300000),
    });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch { /* non-json error body */ }
    if (!r.ok) return { ok: false, err: `HTTP ${r.status} ${(j?.error?.message || txt).slice(0, 120)}`, ms: Date.now() - t0 };
    return { ok: true, text: j?.choices?.[0]?.message?.content || '', usage: j?.usage || {}, ms: Date.now() - t0 };
  } catch (e) { return { ok: false, err: e.message.slice(0, 120), ms: Date.now() - t0 }; }
}

console.log(`\n\x1b[1mvision benchmark\x1b[0m — ${TESTS.length} fixtures, ${MODELS.length} model(s)`);
console.log(`  endpoint ${ENDPOINT}`);
if (imgDir) console.log(`  images   ${imgDir} (your own)`);
console.log('');

const summary = [];
for (const model of MODELS) {
  console.log(`\x1b[1m${model}\x1b[0m`);
  let hit = 0, total = 0, ms = 0, bonuses = 0, failed = 0;
  for (const t of TESTS) {
    const r = await ask(model, t);
    if (!r.ok) {
      console.log(`  \x1b[31m✗\x1b[0m ${t.id.padEnd(22)} ${r.err}`);
      failed++; total += (t.must || []).length;
      continue;
    }
    const s = score(r.text, t);
    hit += s.hit; total += s.total; ms += r.ms;
    if (s.bonus) bonuses++;
    const mark = s.hit === s.total ? '\x1b[32m✓\x1b[0m' : s.hit === 0 ? '\x1b[31m✗\x1b[0m' : '\x1b[33m~\x1b[0m';
    console.log(`  ${mark} ${t.id.padEnd(22)} ${s.hit}/${s.total}` +
      (s.bonus ? '  \x1b[35m[+bonus]\x1b[0m' : '') +
      (s.invented?.length ? `  \x1b[31mINVENTED: ${s.invented.join(', ')}\x1b[0m` : '') +
      (s.missed.length ? `  \x1b[2mmissed: ${s.missed.join(', ')}\x1b[0m` : ''));
    if (VERBOSE) console.log(`      \x1b[2m${r.text.replace(/\s+/g, ' ').slice(0, 300)}\x1b[0m`);
  }
  const pct = total ? (hit / total * 100) : 0;
  summary.push({ model, pct, hit, total, bonuses, failed, avgMs: Math.round(ms / Math.max(1, TESTS.length - failed)) });
  console.log(`  \x1b[1m${pct.toFixed(1)}%\x1b[0m  (${hit}/${total})  avg ${Math.round(ms / Math.max(1, TESTS.length - failed))}ms` +
    (bonuses ? `  ${bonuses} bonus` : '') + (failed ? `  \x1b[31m${failed} errored\x1b[0m` : '') + '\n');
}

if (summary.length > 1) {
  console.log('\x1b[1mranking\x1b[0m');
  summary.sort((a, b) => b.pct - a.pct)
    .forEach((s, i) => console.log(`  ${i + 1}. ${String(s.pct.toFixed(1) + '%').padStart(6)}  ${s.model.padEnd(46)} ${s.avgMs}ms`));
}

console.log(`\n\x1b[2mA good score here means the model can read degraded text and reason about layout —`);
console.log(`  which is what matters when the coding agent can only see through its eyes.\x1b[0m\n`);
