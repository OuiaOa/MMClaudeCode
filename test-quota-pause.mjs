#!/usr/bin/env node
/** Regression test for the MiniMax rolling Token Plan pause/resume gate. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmclaude-quota-test-'));
const configDir = path.join(tmp, 'config');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(configDir); fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(configDir, 'key'), 'mm-test-key');
fs.writeFileSync(path.join(configDir, 'sentinel'), 'mm-test-sentinel');
const upstreamPort = 9931;
const shimPort = 8831;
let quotaPaused = true;
let upstreamCalls = 0;
const resetAt = Date.now() + 150;
const upstream = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/quota') {
    const row = {
      start_time: Date.now() - 1000,
      end_time: resetAt,
      remains_time: Math.max(0, resetAt - Date.now()),
      current_interval_total_count: 10,
      current_interval_usage_count: quotaPaused ? 10 : 0,
      model_name: 'general',
      current_interval_status: 1,
      current_interval_remaining_percent: quotaPaused ? 1 : 100,
      current_weekly_total_count: 100,
      current_weekly_usage_count: quotaPaused ? 99 : 1,
      current_weekly_remaining_percent: quotaPaused ? 1 : 99,
      weekly_end_time: resetAt + 1000,
    };
    res.writeHead(200, {'content-type': 'application/json'});
    return res.end(JSON.stringify({model_remains:[row],base_resp:{status_code:0}}));
  }
  if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
  upstreamCalls++;
  res.writeHead(200, {'content-type':'application/json'});
  res.end(JSON.stringify({id:'quota-test',type:'message',role:'assistant',model:'MiniMax-M3',content:[{type:'text',text:'resumed'}],usage:{input_tokens:5,output_tokens:2}}));
});
await new Promise(resolve => upstream.listen(upstreamPort, '127.0.0.1', resolve));
const base = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.default.json'), 'utf8'));
const cfg = {
  ...base,
  port: shimPort,
  upstream: `http://127.0.0.1:${upstreamPort}/anthropic`,
  balanceUrl: `http://127.0.0.1:${upstreamPort}/quota`,
  balanceMethod: 'GET',
  balance: { settleSeconds: 99999, idlePollSeconds: 99999 },
  trafficPolicy: { maxConcurrent: 2, maxBackgroundConcurrent: 1, minStartIntervalMs: 1, backgroundMinStartIntervalMs: 1, maxQueue: 8 },
  pausePolicy: { enabled: true, pauseBeforePercent: 2, pollIntervalMs: 1, fallbackWaitMs: 20, maxWaitMs: 3000 },
};
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg));
fs.writeFileSync(path.join(configDir, 'probe-results.json'), JSON.stringify({effortField:'output_config',effortSupported:true}));
const shim = spawn(process.execPath, [path.join(import.meta.dirname, 'shim.mjs')], {env:{...process.env,MMCLAUDE_CONFIG_DIR:configDir,MMCLAUDE_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
let log = ''; shim.stdout.on('data', d => log += d); shim.stderr.on('data', d => log += d);
const cleanup = () => { try { shim.kill('SIGKILL'); } catch {} try { upstream.close(); } catch {} };
process.on('exit', cleanup);
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${shimPort}/_mmclaude/health`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 25)); }
const body = { model:'mmclaude-m3-default', max_tokens:100, messages:[{role:'user',content:'wait for reset'}] };
const started = Date.now();
const request = fetch(`http://127.0.0.1:${shimPort}/v1/messages`, {method:'POST',headers:{authorization:'Bearer mm-test-sentinel','content-type':'application/json'},body:JSON.stringify(body)});
await new Promise(r => setTimeout(r, 60));
const held = upstreamCalls === 0;
quotaPaused = false;
const response = await request;
const text = await response.text();
const elapsed = Date.now() - started;
const usage = await (await fetch(`http://127.0.0.1:${shimPort}/_mmclaude/usage`, {headers:{authorization:'Bearer mm-test-sentinel'}})).json();
const checks = [
  ['request held before the reset', held],
  ['request resumed successfully', response.status === 200 && text.includes('resumed')],
  ['upstream was called exactly once after resume', upstreamCalls === 1],
  ['usage exposes quota state', usage.quota?.enabled === true],
  ['usage exposes weekly quota percentage', usage.quota?.weeklyRemainingPercent === (quotaPaused ? 1 : 99)],
  ['pause lasted long enough to cross the reset timer', elapsed >= 100],
];
for (const [name, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${name}`);
cleanup();
if (checks.some(([, ok]) => !ok)) { console.error(log); process.exitCode = 1; }
