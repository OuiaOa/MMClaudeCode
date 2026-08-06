#!/usr/bin/env node
/**
 * Generates a throwaway project for the E2E run: large enough that the agent must actually
 * search rather than read everything, with the defect's numbers spread across separate files
 * so no single file makes the bug obvious.
 *
 * Usage: node gen-project.mjs <game|web> <dest>
 */
import fs from 'node:fs';
import path from 'node:path';

const [kind, dest] = process.argv.slice(2);
if (!kind || !dest) { console.error('usage: gen-project.mjs <game|web> <dest>'); process.exit(1); }
fs.rmSync(dest, { recursive: true, force: true });

const w = (rel, body) => {
  const p = path.join(dest, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

// Filler modules so Glob/Grep have something to chew on and the signal isn't trivially findable.
const filler = (n, dir, prefix) => {
  for (let i = 0; i < n; i++) {
    w(`${dir}/${prefix}${i}.js`,
      `// ${prefix}${i} — generated module\n` +
      `export const ${prefix}${i}Config = { id: '${prefix}${i}', enabled: ${i % 3 !== 0}, weight: ${i * 7 % 13} };\n\n` +
      `export function init${prefix}${i}(ctx) {\n` +
      `  if (!ctx) throw new Error('${prefix}${i}: missing context');\n` +
      `  return { ...${prefix}${i}Config, tick: (dt) => ctx.advance(dt * ${1 + (i % 5)}) };\n}\n`);
  }
};

if (kind === 'game') {
  w('README.md', '# Voxel Skirmish\n\nA small 2D arena game. HUD layout lives in `src/ui/`.\n');
  w('package.json', JSON.stringify({ name: 'voxel-skirmish', version: '0.4.2', type: 'module' }, null, 2));

  // The two colliding numbers live in DIFFERENT files, and neither is wrong on its own.
  w('src/ui/hud-layout.js',
    `// Canvas is 960x540. HUD anchors are laid out from the top edge.\n` +
    `export const HUD = {\n` +
    `  score:     { x: 16,  y: 16 },\n` +
    `  lives:     { x: 16,  y: 38 },\n` +
    `  healthBar: { x: 620, y: 24, width: 320, height: 22 },\n` +
    `};\n`);
  w('src/ui/minimap.js',
    `// The minimap is anchored to the top-right of the 960px canvas.\n` +
    `export const MINIMAP = { x: 700, y: 16, width: 240, height: 160, zIndex: 1 };\n\n` +
    `export function drawMinimap(ctx, world) {\n` +
    `  ctx.save();\n  ctx.translate(MINIMAP.x, MINIMAP.y);\n` +
    `  world.chunks.forEach(c => ctx.fillRect(c.x / 8, c.y / 8, 2, 2));\n  ctx.restore();\n}\n`);
  w('src/ui/health-bar.js',
    `import { HUD } from './hud-layout.js';\n\n` +
    `export const HEALTH_Z = 5;\n\n` +
    `export function drawHealthBar(ctx, hp, maxHp) {\n` +
    `  const { x, y, width, height } = HUD.healthBar;\n` +
    `  ctx.fillStyle = '#0b1220';\n  ctx.fillRect(x, y, width, height);\n` +
    `  ctx.fillStyle = '#ef4444';\n  ctx.fillRect(x, y, width * (hp / maxHp), height);\n` +
    `  ctx.fillText(\`HP \${hp}/\${maxHp}\`, x + 8, y + 15);\n}\n`);
  w('src/entities/player.js',
    `export const PLAYER_SPAWN = { x: 120, y: 300, w: 48, h: 64 };\nexport const PLAYER_SPEED = 3.2;\n`);
  w('src/entities/enemies.js',
    `export const ENEMIES = [\n  { id: 'enemy_a', x: 400, y: 180 },\n  { id: 'enemy_b', x: 640, y: 380 },\n];\n`);
  w('src/main.js',
    `import { drawHealthBar } from './ui/health-bar.js';\nimport { drawMinimap } from './ui/minimap.js';\n\n` +
    `export function renderFrame(ctx, state) {\n  drawMinimap(ctx, state.world);\n` +
    `  drawHealthBar(ctx, state.hp, state.maxHp);\n}\n`);
  filler(28, 'src/systems', 'system');
  filler(16, 'src/audio', 'sfx');
} else {
  w('README.md', '# Landing\n\nMarketing site. Pricing components live in `src/components/pricing/`.\n');
  w('package.json', JSON.stringify({ name: 'landing', version: '1.2.0', type: 'module' }, null, 2));
  w('src/components/pricing/card.css',
    `.plan-card {\n  width: 240px;\n  padding: 20px;\n  background: #fff;\n` +
    `  border: 1px solid #e2e8f0;\n  border-radius: 10px;\n  overflow: hidden;\n}\n`);
  // The defect: this width exceeds the card's content box. Nothing here says 240.
  w('src/components/pricing/cta.css',
    `.plan-cta {\n  width: 380px;\n  padding: 11px 14px;\n  border: 0;\n  border-radius: 7px;\n` +
    `  font-size: 14px;\n  white-space: nowrap;\n  text-align: left;\n}\n\n` +
    `.plan-cta--starter { background: #2563eb; color: #fff; }\n` +
    `.plan-cta--pro { width: 200px; background: #0f172a; color: #fff; text-align: center; }\n`);
  w('src/components/pricing/plans.js',
    `export const PLANS = [\n` +
    `  { id: 'starter', name: 'Starter', price: 12, cta: 'Start your free 30-day trial — no card required' },\n` +
    `  { id: 'pro', name: 'Pro', price: 29, cta: 'Upgrade' },\n];\n`);
  filler(24, 'src/components/marketing', 'block');
  filler(18, 'src/lib', 'util');
}

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else files.push(p);
  }
})(dest);
console.log(`${kind}: ${files.length} files, ${files.reduce((s, f) => s + fs.statSync(f).size, 0)} bytes -> ${dest}`);
