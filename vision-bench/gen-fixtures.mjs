#!/usr/bin/env node
/**
 * Renders the vision benchmark fixtures with headless Chromium, plus machine-checkable ground
 * truth. No photographs, no downloads, no personal data — everything is generated locally and
 * is byte-reproducible, so two people running the benchmark compare like with like.
 *
 * The hard part of a vision benchmark is making it hard. A clean screenshot of clean text is
 * solved by every model worth using, and a suite everything scores 100% on ranks nothing. So
 * these fixtures deliberately reproduce the ways real screenshots and photographs are
 * difficult: small type, low contrast, rotation, blur, glare, occlusion, and layouts where the
 * answer is a spatial relationship rather than a string.
 *
 * Usage: node gen-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const OUT = path.join(DIR, 'fixtures');
fs.mkdirSync(OUT, { recursive: true });

function findChrome() {
  const cands = [];
  const pw = path.join(process.env.HOME || '', '.cache', 'ms-playwright');
  if (fs.existsSync(pw)) {
    for (const d of fs.readdirSync(pw).filter(d => d.startsWith('chromium-'))) {
      cands.push(path.join(pw, d, 'chrome-linux64', 'chrome'), path.join(pw, d, 'chrome-linux', 'chrome'));
    }
  }
  cands.push(
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  return cands.find(p => { try { return fs.existsSync(p); } catch { return false; } });
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('No Chromium/Chrome found. Install one, or run Playwright\'s: npx playwright install chromium');
  process.exit(1);
}

// Grain + glare overlays, so "photographed screen" fixtures look photographed rather than clean.
const GRAIN = `<svg style="position:absolute;width:0;height:0"><filter id="grain">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>
  <feColorMatrix type="saturate" values="0"/></filter></svg>`;
const grainLayer = (o = 0.22) =>
  `<div style="position:absolute;inset:0;filter:url(#grain);opacity:${o};pointer-events:none;mix-blend-mode:multiply"></div>`;
const glare = (x, y, r) =>
  `<div style="position:absolute;left:${x}px;top:${y}px;width:${r}px;height:${r}px;border-radius:50%;
     background:radial-gradient(circle,rgba(255,255,255,.85),rgba(255,255,255,0) 70%);pointer-events:none"></div>`;

const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const SANS = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
// Irregular "written by hand" text, simulated with deterministic per-character jitter rather
// than a script font. Fonts differ between machines, so a font-dependent fixture would render
// at a different difficulty for every person running the benchmark — and would silently fall
// back to a clean sans face wherever the font is missing, as it does on stock Linux.
function jitter(text, seed = 7) {
  let h = seed;
  const rnd = () => (h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  return [...text].map(ch => {
    if (ch === ' ') return ' ';
    const rot = (rnd() * 9 - 4.5).toFixed(1);
    const dy = (rnd() * 4 - 2).toFixed(1);
    const sx = (0.9 + rnd() * 0.25).toFixed(2);
    return `<span style="display:inline-block;transform:rotate(${rot}deg) translateY(${dy}px) scaleX(${sx})">${ch}</span>`;
  }).join('');
}

const FIXTURES = [
  // 1 — baseline legibility. Everything should pass this; it catches a broken setup.
  {
    id: '01-plain-text', w: 800, h: 300,
    ask: 'Transcribe all text in this image exactly.',
    must: [['INV-4417-QX'], ['92.60'], ['Northbridge']],
    html: `<body style="margin:0;padding:30px;font-family:${SANS};background:#fff">
      <h2 style="margin:0 0 10px">Invoice INV-4417-QX</h2>
      <p style="font-size:14px">Supplier: Northbridge Components Ltd</p>
      <p style="font-size:14px">Amount due: £92.60 by 14 March</p></body>`,
  },

  // 2 — small type. 9px is the size real UI fine print actually uses.
  {
    id: '02-fine-print', w: 800, h: 260,
    ask: 'Read every piece of text including the smallest print. Report the licence code, the build hash and the batch number exactly.',
    must: [['QX-7731-LM'], ['b4e9f21'], ['BATCH-0093-D']],
    html: `<body style="margin:0;padding:26px;font-family:${SANS};background:#fff">
      <h3 style="margin:0 0 8px;font-size:16px">Aurora Engine</h3>
      <p style="font-size:12px;color:#333">Community edition, offline build.</p>
      <p style="font-size:9px;color:#777;margin-top:22px">Licence QX-7731-LM &middot; build b4e9f21 &middot; BATCH-0093-D &middot; compiled 03:14 UTC</p></body>`,
  },

  // 3 — low contrast. Pale grey on white is a real accessibility failure mode.
  {
    id: '03-low-contrast', w: 800, h: 240,
    ask: 'Transcribe all text, including any that is faint or low contrast.',
    must: [['ZB-19'], ['0.00042'], ['perihelion']],
    html: `<body style="margin:0;padding:30px;font-family:${SANS};background:#fafafa">
      <p style="font-size:15px;color:#111">Run summary</p>
      <p style="font-size:13px;color:#c9c9c9">Cross-reference batch ZB-19 before recalibrating.</p>
      <p style="font-size:13px;color:#d4d4d4">Residual drift 0.00042 rad/s at perihelion.</p></body>`,
  },

  // 4 — rotation + blur + grain: a form photographed by hand in poor light.
  {
    id: '04-photographed-form', w: 820, h: 560,
    ask: 'This is a photograph of a paper form, taken at an angle in poor light. Transcribe all printed text and all hand-filled entries exactly, including reference numbers and dates.',
    must: [['SERVICE RECORD'], ['AC-2024-118'], ['R-410A'], [/1[45]\/0?6\/202[45]/]],
    html: `<body style="margin:0;background:#5a5348;overflow:hidden">${GRAIN}
      <div style="position:relative;width:820px;height:560px">
        <div style="position:absolute;left:70px;top:52px;width:660px;background:#f2ede2;padding:22px;
                    font-family:${SANS};transform:rotate(-3.2deg);filter:blur(0.7px) contrast(0.9) brightness(0.94);
                    box-shadow:0 8px 26px rgba(0,0,0,.5)">
          <div style="font-weight:700;font-size:17px;letter-spacing:.5px">SERVICE RECORD</div>
          <div style="font-size:11px;color:#444;margin:6px 0 14px">Retain for warranty purposes. Ref AS1677.2</div>
          <div style="font-size:12px">Unit ID: <span style="font-size:17px;color:#1a2a4a">${jitter('AC-2024-118', 11)}</span></div>
          <div style="font-size:12px;margin-top:8px">Refrigerant: <span style="font-size:17px;color:#1a2a4a">${jitter('R-410A', 23)}</span></div>
          <div style="font-size:12px;margin-top:8px">Date serviced: <span style="font-size:17px;color:#1a2a4a">${jitter('14/06/2025', 41)}</span></div>
          <div style="font-size:12px;margin-top:8px">Technician: <span style="font-size:17px;color:#1a2a4a">${jitter('M. Okafor', 59)}</span></div>
          <div style="font-size:10px;color:#555;margin-top:16px">Next inspection due within 12 months of the date above.</div>
        </div>
        ${glare(520, 40, 300)}${grainLayer(0.3)}
      </div></body>`,
  },

  // 5 — spatial: the answer is a relationship, not a string.
  {
    id: '05-overlap', w: 900, h: 500,
    ask: 'Describe the layout. Identify any elements that overlap each other, name them, and say which is drawn in front.',
    must: [['notification', 'toast', 'alert'], ['save', 'button'], ['overlap', 'covers', 'on top', 'obscur', 'in front']],
    html: `<body style="margin:0;padding:24px;font-family:${SANS};background:#eef2f7">
      <div style="position:relative;width:840px;height:420px;background:#fff;border:1px solid #d8dee9;border-radius:8px">
        <div style="padding:18px;font-size:15px;font-weight:600">Document settings</div>
        <div style="padding:0 18px;font-size:13px;color:#555">Changes apply to the current workspace only.</div>
        <button style="position:absolute;left:18px;top:340px;width:130px;padding:10px;background:#2563eb;
                       color:#fff;border:0;border-radius:6px;font-size:14px;z-index:1">Save changes</button>
        <div style="position:absolute;left:96px;top:326px;width:300px;padding:12px 14px;background:#111827;
                    color:#fff;border-radius:8px;font-size:13px;z-index:9;box-shadow:0 6px 18px rgba(0,0,0,.3)">
          Notification: workspace synced</div>
      </div></body>`,
  },

  // 6 — precise value lookup from a grid.
  {
    id: '06-table', w: 820, h: 380,
    ask: 'Read the table. Give the Latency value for the Frankfurt row, and name the region with the highest error count.',
    must: [['218'], ['mumbai']],
    html: `<body style="margin:0;padding:26px;font-family:${SANS};background:#fff;font-size:13px">
      <table style="border-collapse:collapse;width:560px">
        <tr style="background:#111827;color:#fff"><th style="padding:8px;text-align:left">Region</th><th style="padding:8px">Latency (ms)</th><th style="padding:8px">Errors</th></tr>
        ${[['Dublin', 94, 12], ['Frankfurt', 218, 37], ['Mumbai', 176, 104], ['Oregon', 61, 8]]
      .map(([r, l, e]) => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${r}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${l}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${e}</td></tr>`).join('')}
      </table></body>`,
  },

  // 7 — orientation. A vertically symmetric scene rotated 180 degrees.
  {
    id: '07-inverted', w: 700, h: 700,
    ask: 'Describe this image in detail, including anything unusual about the image itself or its orientation.',
    must: [['tree', 'foliage', 'landscape', 'hill'], ['reflect', 'water', 'lake', 'mirror']],
    bonus: [['upside down', 'upside-down', 'inverted', 'flipped', 'rotated 180']],
    html: `<body style="margin:0"><div style="width:700px;height:700px;transform:rotate(180deg)">
      <div style="height:350px;background:linear-gradient(#bcd6ef,#e8f1fa);position:relative">
        <div style="position:absolute;bottom:0;left:60px;width:0;height:0;border-left:70px solid transparent;
                    border-right:70px solid transparent;border-bottom:150px solid #4a7c59"></div>
        <div style="position:absolute;bottom:0;left:200px;width:0;height:0;border-left:90px solid transparent;
                    border-right:90px solid transparent;border-bottom:200px solid #3f6b4b"></div>
        <div style="position:absolute;bottom:0;left:420px;width:0;height:0;border-left:60px solid transparent;
                    border-right:60px solid transparent;border-bottom:120px solid #4a7c59"></div>
        <div style="position:absolute;top:40px;right:80px;width:70px;height:70px;border-radius:50%;background:#f7e08a"></div>
      </div>
      <div style="height:350px;background:linear-gradient(#dfeaf5,#9fb8cf);position:relative;transform:scaleY(-1);opacity:.85">
        <div style="position:absolute;bottom:0;left:60px;width:0;height:0;border-left:70px solid transparent;
                    border-right:70px solid transparent;border-bottom:150px solid #4a7c59"></div>
        <div style="position:absolute;bottom:0;left:200px;width:0;height:0;border-left:90px solid transparent;
                    border-right:90px solid transparent;border-bottom:200px solid #3f6b4b"></div>
        <div style="position:absolute;bottom:0;left:420px;width:0;height:0;border-left:60px solid transparent;
                    border-right:60px solid transparent;border-bottom:120px solid #4a7c59"></div>
        <div style="position:absolute;top:40px;right:80px;width:70px;height:70px;border-radius:50%;background:#f7e08a"></div>
      </div></div></body>`,
  },

  // 8 — code with an off-by-one. Requires reading the code, not just transcribing it.
  {
    id: '08-code-bug', w: 860, h: 420,
    ask: 'Transcribe this code with its line numbers. Then state which line contains an off-by-one error and why.',
    must: [['totalPrice'], ['i <= items.length', 'i<=items.length', '<='], ['4']],
    html: `<body style="margin:0;padding:24px;background:#1e1e2e"><pre style="font-family:${MONO};font-size:14px;color:#cdd6f4;line-height:1.6;margin:0">
<span style="color:#6c7086">1</span>  <span style="color:#cba6f7">function</span> <span style="color:#89b4fa">calcTotal</span>(items) {
<span style="color:#6c7086">2</span>    <span style="color:#cba6f7">let</span> totalPrice = <span style="color:#fab387">0</span>;
<span style="color:#6c7086">3</span>
<span style="color:#6c7086">4</span>    <span style="color:#cba6f7">for</span> (<span style="color:#cba6f7">let</span> i = <span style="color:#fab387">0</span>; i &lt;= items.length; i++) {
<span style="color:#6c7086">5</span>      totalPrice += items[i].price;
<span style="color:#6c7086">6</span>    }
<span style="color:#6c7086">7</span>    <span style="color:#cba6f7">return</span> totalPrice;
<span style="color:#6c7086">8</span>  }</pre></body>`,
  },

  // 9 — occlusion: part of the value is genuinely hidden. An honest model says so.
  {
    id: '09-occluded', w: 760, h: 300,
    ask: 'Report the order reference exactly. If any part of it is not visible, say so rather than guessing.',
    // Tests two behaviours at once: report the part that IS legible, and admit the part that
    // is not. A model that invents the hidden characters fails the second half.
    must: [['po-884', 'po-88'], ['obscur', 'hidden', 'covered', 'partially', 'cut off', 'not visible', 'illegible', 'unclear']],
    mustNot: [['po-8842-ktx']],
    html: `<body style="margin:0;padding:30px;font-family:${SANS};background:#fff">
      <div style="position:relative;display:inline-block">
        <div style="font-size:22px;font-weight:600">Order PO-8842-KTX</div>
        <div style="position:absolute;left:152px;top:-6px;width:104px;height:40px;background:#ffd54a;
                    transform:rotate(-4deg);box-shadow:0 2px 6px rgba(0,0,0,.2)"></div>
      </div>
      <p style="font-size:13px;color:#555;margin-top:20px">A sticky note covers part of the reference.</p></body>`,
  },
];

const truth = [];
for (const f of FIXTURES) {
  const htmlFile = path.join(OUT, `${f.id}.html`);
  const pngFile = path.join(OUT, `${f.id}.png`);
  fs.writeFileSync(htmlFile, `<html>${f.html}</html>`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--screenshot=${pngFile}`, `--window-size=${f.w},${f.h}`, `file://${htmlFile}`,
  ], { stdio: 'ignore' });
  fs.unlinkSync(htmlFile);
  truth.push({
    id: f.id, png: path.relative(DIR, pngFile), ask: f.ask,
    must: f.must.map(alts => alts.map(a => (a instanceof RegExp ? { re: a.source, flags: a.flags } : a))),
    bonus: f.bonus?.map(alts => alts.map(String)) || null,
    mustNot: f.mustNot?.map(alts => alts.map(String)) || null,
  });
  console.log(`  ${f.id.padEnd(22)} ${String(fs.statSync(pngFile).size).padStart(7)} bytes  ${f.w}x${f.h}`);
}

fs.writeFileSync(path.join(DIR, 'truth.json'), JSON.stringify(truth, null, 2));
console.log(`\n${truth.length} fixtures -> ${OUT}\ntruth -> ${path.join(DIR, 'truth.json')}`);
