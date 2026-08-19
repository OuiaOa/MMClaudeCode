#!/usr/bin/env node
/** Focused MMClaude regression test for MiniMax tier routing and native multimodality. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mmclaude-test-'));
const configDir = path.join(tmp, 'config');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(configDir); fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(configDir, 'key'), 'mm-test-key');
fs.writeFileSync(path.join(configDir, 'sentinel'), 'mm-test-sentinel');
const port = 9921;
const shimPort = 8821;
const seen = [];
let upstreamActive = 0;
let maxUpstreamActive = 0;
let backgroundUpstreamActive = 0;
let maxBackgroundUpstreamActive = 0;
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    seen.push(body);
    upstreamActive++;
    maxUpstreamActive = Math.max(maxUpstreamActive, upstreamActive);
    const isBackground = body.model === 'MiniMax-M2.5' || body.model === 'MiniMax-M2.7-highspeed';
    if (isBackground) {
      backgroundUpstreamActive++;
      maxBackgroundUpstreamActive = Math.max(maxBackgroundUpstreamActive, backgroundUpstreamActive);
    }
    setTimeout(() => {
      res.writeHead(200, {'content-type': body.stream ? 'text/event-stream' : 'application/json'});
      if (body.stream) {
        res.end('event: message_start\ndata: ' + JSON.stringify({type:'message_start',message:{usage:{input_tokens:12,output_tokens:1}}}) + '\n\n' +
          'event: content_block_delta\ndata: ' + JSON.stringify({type:'content_block_delta',delta:{text:'ok'}}) + '\n\n' +
          'event: message_delta\ndata: ' + JSON.stringify({type:'message_delta',usage:{output_tokens:3}}) + '\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n');
      } else res.end(JSON.stringify({id:'mm-test',type:'message',role:'assistant',model:body.model,content:[{type:'text',text:'ok'}],usage:{input_tokens:12,output_tokens:3}}));
      upstreamActive--;
      if (isBackground) backgroundUpstreamActive--;
    }, 40);
  });
});
await new Promise(r => upstream.listen(port, '127.0.0.1', r));
const base = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'config.default.json'), 'utf8'));
const cfg = {...base, port: shimPort, upstream: `http://127.0.0.1:${port}/anthropic`, cap:{dailyUsd:0}, balance:{settleSeconds:99999,idlePollSeconds:99999},
  trafficPolicy:{maxConcurrent:2,maxBackgroundConcurrent:1,minStartIntervalMs:10,backgroundMinStartIntervalMs:10,maxQueue:64,backgroundMaxOutputTokens:8192,subagentMaxOutputTokens:16384},
  nativeMultimodal:true};
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(cfg));
fs.writeFileSync(path.join(configDir, 'probe-results.json'), JSON.stringify({availableModels:['MiniMax-M3','MiniMax-M2.7','MiniMax-M2.7-highspeed','MiniMax-M2.5']}));
const shim = spawn(process.execPath, [path.join(import.meta.dirname, 'shim.mjs')], {env:{...process.env,MMCLAUDE_CONFIG_DIR:configDir,MMCLAUDE_DATA_DIR:dataDir},stdio:['ignore','pipe','pipe']});
let log=''; shim.stdout.on('data', d => log += d); shim.stderr.on('data', d => log += d);
const cleanup = () => { try { shim.kill('SIGKILL'); } catch {} try { upstream.close(); } catch {} };
process.on('exit', cleanup);
for (let i=0;i<50;i++) { try { if ((await fetch(`http://127.0.0.1:${shimPort}/_mmclaude/health`)).ok) break; } catch {} await new Promise(r=>setTimeout(r,50)); }
let pass=0, fail=0;
const check=(name, ok, detail='') => { if(ok){console.log(`  ✓ ${name}`);pass++;}else{console.log(`  ✗ ${name}${detail?` -> ${detail}`:''}`);fail++;} };
async function send(body){const r=await fetch(`http://127.0.0.1:${shimPort}/v1/messages`,{method:'POST',headers:{authorization:'Bearer mm-test-sentinel','content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,text:await r.text()};}
const msg = (model, extra={}) => ({model,max_tokens:100,messages:[{role:'user',content:'hello'}],...extra});
console.log('\nMMClaude MiniMax tests\n');
await send(msg('mmclaude-m3-default',{output_config:{effort:'high'}}));
check('Default uses MiniMax-M3', seen.at(-1)?.model === 'MiniMax-M3');
check('Default keeps M3 thinking disabled', seen.at(-1)?.thinking?.type === 'disabled');
await send(msg('mmclaude-m3-thinking'));
check('Fable/Opus profile uses M3', seen.at(-1)?.model === 'MiniMax-M3');
check('Fable/Opus enables adaptive thinking', seen.at(-1)?.thinking?.type === 'adaptive');
await send(msg('mmclaude-m2.7-thinking'));
check('Sonnet profile uses M2.7', seen.at(-1)?.model === 'MiniMax-M2.7');
await send(msg('mmclaude-m2.7-highspeed-thinking'));
check('Haiku profile uses M2.7 highspeed', seen.at(-1)?.model === 'MiniMax-M2.7-highspeed');
await send(msg('mmclaude-m2.5-background'));
check('Background profile uses M2.5 when available', seen.at(-1)?.model === 'MiniMax-M2.5');
await send(msg('mmclaude-m2.5-background',{messages:[{role:'user',content:[{type:'text',text:'inspect this'},{type:'image',source:{type:'base64',media_type:'image/png',data:'aGVsbG8='}}]}]}));
check('M3-compatible media remains native', Array.isArray(seen.at(-1)?.messages?.[0]?.content) && seen.at(-1).messages[0].content.some(x=>x.type==='image'));
check('Claude effort fields are removed upstream', !('output_config' in seen.at(-1)) && !('reasoning' in seen.at(-1)));
await send(msg('mmclaude-m3-default',{metadata:{user_id:'ultra-test'},output_config:{effort:'xhigh'}}));
check('ultracode keeps M3 adaptive thinking', seen.at(-1)?.thinking?.type === 'adaptive');
check('ultracode adds the parallel dispatch hint', JSON.stringify(seen.at(-1)?.system || '').includes('PARALLEL DISPATCH'));
const concurrentMain = await Promise.all(Array.from({length:4}, () => send(msg('mmclaude-m3-default'))));
check('main fan-out is queued at two concurrent upstream calls', concurrentMain.every(x=>x.status === 200) && maxUpstreamActive <= 2, String(maxUpstreamActive));
const concurrentBackground = await Promise.all(Array.from({length:4}, () => send(msg('mmclaude-m2.5-background',{max_tokens:100000}))));
const backgroundBodies = seen.slice(-4);
check('background fan-out remains connected but uses one upstream lane', concurrentBackground.every(x=>x.status === 200) && maxBackgroundUpstreamActive <= 1, String(maxBackgroundUpstreamActive));
check('background completions are capped', backgroundBodies.every(x=>x.max_tokens === 8192), JSON.stringify(backgroundBodies.map(x=>x.max_tokens)));
const rows=fs.readFileSync(path.join(dataDir,'usage.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
check('usage ledger records MiniMax token usage', rows.length >= 14 && rows.every(x=>x.provider==='minimax' && x.inputTokens > 0));
console.log(`\n${pass} passed, ${fail} failed\n`);
cleanup();
if (fail) { console.error(log); process.exitCode=1; }
