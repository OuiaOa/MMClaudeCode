#!/usr/bin/env node
/**
 * Renders the end-to-end scenario images, with machine-checkable ground truth.
 *
 * The design point: in both scenes the defect is visible ONLY in the render. Every individual
 * number in the source looks reasonable and the bug emerges from their combination, so an agent
 * that never receives the image cannot answer, and one that guesses from the source guesses
 * wrong. That is what makes these a test of the vision path rather than a test of reading CSS.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DIR = import.meta.dirname;
const OUT = path.join(DIR, 'scenes');
fs.mkdirSync(OUT, { recursive: true });

const CHROME = fs.readdirSync(`${process.env.HOME}/.cache/ms-playwright`)
  .filter(d => d.startsWith('chromium-'))
  .map(d => `${process.env.HOME}/.cache/ms-playwright/${d}/chrome-linux64/chrome`)
  .find(p => fs.existsSync(p));
if (!CHROME) { console.error('no playwright chromium found'); process.exit(1); }

// ---------------------------------------------------------------------- game
// 960x540 canvas. The health bar is 320px wide starting at x=620, so it runs to x=940 and
// collides with the minimap (x=700..940) — ~240px of overlap, health bar painted on top.
const SPRITES = [
  { id: 'player',  x: 120, y: 300, w: 48, h: 64, colour: '#4ade80', label: 'PLAYER' },
  { id: 'enemy_a', x: 400, y: 180, w: 40, h: 40, colour: '#f87171', label: 'E1' },
  { id: 'enemy_b', x: 640, y: 380, w: 40, h: 40, colour: '#f87171', label: 'E2' },
  { id: 'pickup',  x: 820, y: 460, w: 24, h: 24, colour: '#fbbf24', label: 'STAR' },
];

const gameHtml = `<body style="margin:0;background:#0f172a;font-family:ui-monospace,Menlo,monospace">
  <div style="position:relative;width:960px;height:540px;background:linear-gradient(#1e293b,#0f172a);overflow:hidden">
    <div style="position:absolute;left:0;top:480px;width:960px;height:60px;background:#334155"></div>
    ${SPRITES.map(s => `
      <div style="position:absolute;left:${s.x}px;top:${s.y}px;width:${s.w}px;height:${s.h}px;
                  background:${s.colour};display:flex;align-items:center;justify-content:center;
                  color:#0f172a;font-size:10px;font-weight:700;border-radius:4px">${s.label}</div>`).join('')}
    <div style="position:absolute;left:16px;top:16px;color:#e2e8f0;font-size:13px">SCORE 004120</div>
    <div style="position:absolute;left:16px;top:38px;color:#e2e8f0;font-size:13px">LIVES 3</div>
    <div style="position:absolute;left:700px;top:16px;width:240px;height:160px;background:#1e293b;
                border:2px solid #64748b;z-index:1">
      <div style="color:#94a3b8;font-size:11px;padding:4px">MINIMAP</div></div>
    <div style="position:absolute;left:620px;top:24px;width:320px;height:22px;background:#0b1220;
                border:2px solid #ef4444;z-index:5">
      <div style="width:62%;height:100%;background:#ef4444"></div></div>
    <div style="position:absolute;left:628px;top:26px;color:#fff;font-size:12px;z-index:6">HP 62/100</div>
  </div></body>`;

// ----------------------------------------------------------------------- web
// The Starter CTA is 380px wide inside a 240px content box: it overflows right by ~140px and
// its label is cut off mid-word by the card's overflow:hidden. Left-aligned so the truncation
// is unmistakable rather than symmetric. The Pro card next to it is correct, so the agent has to
// identify WHICH one is broken rather than just noticing that a button exists.
const webHtml = `<body style="margin:0;padding:40px;background:#f8fafc;font-family:system-ui,sans-serif">
  <h1 style="font-size:24px;margin:0 0 24px;color:#0f172a">Choose a plan</h1>
  <div style="display:flex;gap:24px;align-items:flex-start">
    <div style="width:240px;padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
      <div style="font-size:15px;font-weight:600;color:#0f172a">Starter</div>
      <div style="font-size:30px;font-weight:700;margin:8px 0;color:#0f172a">$12</div>
      <ul style="font-size:13px;color:#475569;padding-left:18px;margin:12px 0">
        <li>5 projects</li><li>2 GB storage</li></ul>
      <button style="width:380px;padding:11px;background:#2563eb;color:#fff;border:0;border-radius:7px;
                     font-size:14px;white-space:nowrap;text-align:left;padding-left:14px">Start your free 30-day trial — no card required</button>
    </div>
    <div style="width:240px;padding:20px;background:#fff;border:1px solid #e2e8f0;border-radius:10px">
      <div style="font-size:15px;font-weight:600;color:#0f172a">Pro</div>
      <div style="font-size:30px;font-weight:700;margin:8px 0;color:#0f172a">$29</div>
      <ul style="font-size:13px;color:#475569;padding-left:18px;margin:12px 0">
        <li>Unlimited projects</li><li>50 GB storage</li></ul>
      <button style="width:200px;padding:11px;background:#0f172a;color:#fff;border:0;border-radius:7px;font-size:14px">Upgrade</button>
    </div>
  </div></body>`;

const SCENES = [
  {
    id: 'game-hud', w: 960, h: 540, html: gameHtml,
    truth: {
      // Any answer must name BOTH colliding elements and the fact of the collision.
      mustAll: [['health', 'hp'], ['minimap'], ['overlap', 'overlapping', 'collide', 'on top of', 'covers', 'obscur']],
      spriteIds: SPRITES.map(s => s.id),
      note: 'health bar x=620..940 over minimap x=700..940, ~240px overlap, bar on top (z 5 vs 1)',
    },
  },
  {
    id: 'pricing-page', w: 900, h: 520, html: webHtml,
    truth: {
      mustAll: [['starter'], ['overflow', 'clipped', 'cut off', 'wider than', 'extends beyond', 'too wide']],
      mustNot: [['pro card is broken', 'upgrade button overflows']],
      note: 'Starter CTA 380px inside a 240px content box — overflows right ~140px; label reads \"Start your free 30-day trial — no card required\" but is cut off around \"no card\"',
    },
  },
];

const truth = [];
for (const s of SCENES) {
  const htmlFile = path.join(OUT, `${s.id}.html`);
  const pngFile = path.join(OUT, `${s.id}.png`);
  fs.writeFileSync(htmlFile, `<html>${s.html}</html>`);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--screenshot=${pngFile}`, `--window-size=${s.w},${s.h}`, `file://${htmlFile}`,
  ], { stdio: 'ignore' });
  truth.push({ id: s.id, png: pngFile, bytes: fs.statSync(pngFile).size, ...s.truth });
  console.log(`  ${s.id.padEnd(14)} ${String(fs.statSync(pngFile).size).padStart(7)} bytes  ${s.w}x${s.h}`);
}
fs.writeFileSync(path.join(DIR, 'scene-truth.json'), JSON.stringify(truth, null, 2));
console.log(`\nscenes -> ${OUT}`);
