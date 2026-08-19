#!/usr/bin/env node
/** Fast MiniMax capability probe. It discovers model availability and M3 thinking semantics. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import http from 'node:http';

const HOME = os.homedir();
const CONFIG_DIR = process.env.MMCLAUDE_CONFIG_DIR || path.join(HOME, '.config', 'mmclaude');
const cfg = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
const KEY = fs.readFileSync(path.join(CONFIG_DIR, 'key'), 'utf8').trim();
const OUT_FILE = path.join(CONFIG_DIR, 'probe-results.json');
const endpoint = new URL(cfg.upstream || 'https://api.minimax.io/anthropic');
const request = (url, { method = 'GET', body = null } = {}) => new Promise(resolve => {
  const u = new URL(url); const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = (u.protocol === 'http:' ? http : https).request({ hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: `${u.pathname}${u.search}`, method, headers: { authorization: `Bearer ${KEY}`, accept: 'application/json', ...(data ? {'content-type':'application/json','content-length':data.length} : {}) }, timeout: 30000 }, res => {
    const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch {} resolve({status: res.statusCode || 0, json, text}); });
  });
  req.on('timeout', () => { req.destroy(); resolve({status: 0, json: null, text: 'timeout'}); });
  req.on('error', e => resolve({status: 0, json: null, text: e.message}));
  if (data) req.end(data); else req.end();
});

if (!KEY) { console.error('No MiniMax key found. Run mmclaude setup first.'); process.exit(1); }
console.log('\nmmclaude probe — MiniMax models and M3 capabilities\n');
const modelResult = await request(cfg.modelsUrl || 'https://api.minimax.io/anthropic/v1/models');
const listed = Array.isArray(modelResult.json?.data) ? modelResult.json.data.map(x => x.id).filter(Boolean) : [];
const candidates = ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'];
const availableModels = listed.length ? candidates.filter(x => listed.includes(x)) : candidates;
const results = {
  probedAt: new Date().toISOString(),
  availableModels,
  modelList: listed,
  modelListAvailable: modelResult.status >= 200 && modelResult.status < 300,
  nativeMultimodal: true,
  thinkingMode: 'adaptive-or-disabled',
  effortField: 'thinking',
  effortSupported: false,
  countTokensSupported: false,
  probes: {
    models: { ok: modelResult.status >= 200 && modelResult.status < 300, summary: listed.length ? listed.join(', ') : `model list unavailable (HTTP ${modelResult.status})` },
  },
};
if (listed.length && !listed.includes('MiniMax-M3')) console.log(`  ! MiniMax-M3 was not listed: ${listed.join(', ')}`);
else console.log(`  ✓ available models: ${availableModels.join(', ') || 'using documented defaults'}`);

const messagesUrl = `${endpoint.href.replace(/\/$/, '')}/v1/messages`;
const base = await request(messagesUrl, { method: 'POST', body: { model: 'MiniMax-M3', max_tokens: 32, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Reply with ok' }] } });
results.probes.m3ThinkingDisabled = { ok: base.status === 200, status: base.status, summary: base.status === 200 ? 'thinking disabled accepted' : `HTTP ${base.status}` };
const adaptive = await request(messagesUrl, { method: 'POST', body: { model: 'MiniMax-M3', max_tokens: 32, thinking: { type: 'adaptive' }, messages: [{ role: 'user', content: 'Reply with ok' }] } });
results.probes.m3ThinkingAdaptive = { ok: adaptive.status === 200, status: adaptive.status, summary: adaptive.status === 200 ? 'adaptive thinking accepted' : `HTTP ${adaptive.status}` };
results.usageKeys = Object.keys(base.json?.usage || {});
results.usageHasCacheFields = results.usageKeys.some(k => /cache/i.test(k));
results.thinkingDisabledHonored = base.status === 200;
results.thinkingAdaptiveAccepted = adaptive.status === 200;
fs.writeFileSync(OUT_FILE, JSON.stringify(results, null, 2));
try { fs.chmodSync(OUT_FILE, 0o600); } catch {}
console.log(`  ${base.status === 200 ? '✓' : '✗'} M3 thinking disabled: ${base.status}`);
console.log(`  ${adaptive.status === 200 ? '✓' : '✗'} M3 adaptive thinking: ${adaptive.status}`);
console.log(`\nWrote ${OUT_FILE}\n`);
