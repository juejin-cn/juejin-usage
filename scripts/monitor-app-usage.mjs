#!/usr/bin/env node
/**
 * 持续监控 Juejin Usage 桌面应用（Electron 全部进程）的 CPU / 内存占用，
 * 并提供一个实时 HTML 页面查看变化曲线。
 *
 * 用法:
 *   node scripts/monitor-app-usage.mjs                # 默认监控 dev Electron + 打包版 Juejin Usage
 *   node scripts/monitor-app-usage.mjs --port 4650
 *   node scripts/monitor-app-usage.mjs --interval 300   # 默认已是 300ms
 *   node scripts/monitor-app-usage.mjs --pattern "Juejin Usage"   # 自定义进程匹配正则
 *   node scripts/monitor-app-usage.mjs --log /tmp/tud-cpu.jsonl   # 同时落盘采样数据
 *
 * 打开 http://localhost:4650 查看实时曲线。
 * 会自动 tail ~/.ai-usage/logs/sync.log，把每轮同步的开始/完成/出错
 * （含 reason：poll / notify.signal / startup 和耗时）标成竖线，
 * 方便对照后台轮询和"点同步"时的 CPU 峰值。页面上也有手动"标记"按钮。
 */
import { execFile } from 'node:child_process';
import { appendFile, open, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------- CLI args ----------
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
}

const PORT = Number(argValue('port', '4650'));
const INTERVAL_MS = Math.max(200, Number(argValue('interval', '300')));
const MAX_POINTS = Number(argValue('max-points', '14400')); // 默认保留 4 小时 @1s
const LOG_FILE = argValue('log', '');
const DEFAULT_PATTERN =
  'Juejin Usage\\.app|tud-sync-worker|juejin-usage/.*/electron/dist/Electron\\.app|ai-usage/node_modules/.*electron/dist/Electron\\.app';
const PATTERN = new RegExp(argValue('pattern', DEFAULT_PATTERN));
const DATA_DIR = process.env.TUD_DATA_DIR || join(homedir(), '.ai-usage');
const SYNC_DONE_PATH = join(DATA_DIR, 'sync.done');
const SYNC_LOG_PATH = join(DATA_DIR, 'logs', 'sync.log');

// ---------- process classification ----------
function classify(command) {
  if (command.includes('chrome_crashpad_handler')) return 'crashpad';
  if (
    command.includes('tud-sync-worker') ||
    command.includes('Juejin Usage Sync') ||
    command.includes('node.mojom.NodeService')
  ) {
    return 'sync';
  }
  if (command.includes('Helper (GPU)')) return 'gpu';
  if (command.includes('Helper (Renderer)')) return 'renderer';
  if (command.includes('Helper (Plugin)')) return 'plugin';
  if (command.includes('Helper')) return 'utility';
  return 'main';
}

// ---------- sampling ----------
function runPs() {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,pcpu=,rss=,command='],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

const samples = []; // { t, cpu:{total,main,renderer,gpu,sync,other}, mem:{...}, procs:[...] }
const events = []; // { t, label, kind: 'auto' | 'manual' | 'start' | 'phase' }
const phases = []; // { t, phase, source, pid, role, wallMs, cpuMs }
let lastSyncDoneMtime = 0;

async function sampleOnce() {
  const now = Date.now();
  let stdout;
  try {
    stdout = await runPs();
  } catch (err) {
    console.error('[monitor] ps failed:', err.message);
    return;
  }

  const procs = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const command = m[4];
    if (!PATTERN.test(command)) continue;
    const type = classify(command);
    if (type === 'crashpad') continue; // 常驻 0%，噪音
    procs.push({
      pid: Number(m[1]),
      cpu: Number(m[2]),
      memMB: Math.round((Number(m[3]) / 1024) * 10) / 10, // rss KB → MB
      type,
      cmd: command.length > 160 ? command.slice(0, 157) + '…' : command,
    });
  }

  const cpu = { total: 0, main: 0, renderer: 0, gpu: 0, sync: 0, other: 0 };
  const mem = { total: 0, main: 0, renderer: 0, gpu: 0, sync: 0, other: 0 };
  for (const p of procs) {
    const key = ['main', 'renderer', 'gpu', 'sync'].includes(p.type) ? p.type : 'other';
    cpu[key] += p.cpu;
    mem[key] += p.memMB;
    cpu.total += p.cpu;
    mem.total += p.memMB;
  }
  for (const k of Object.keys(cpu)) cpu[k] = Math.round(cpu[k] * 10) / 10;
  for (const k of Object.keys(mem)) mem[k] = Math.round(mem[k] * 10) / 10;

  const sample = { t: now, cpu, mem, procs };
  samples.push(sample);
  if (samples.length > MAX_POINTS) samples.splice(0, samples.length - MAX_POINTS);

  if (LOG_FILE) {
    appendFile(LOG_FILE, JSON.stringify(sample) + '\n').catch(() => {});
  }

  // 优先 tail sync.log 拿到同步的开始/完成/出错事件（含 reason 和耗时）；
  // 日志不存在时退回到 sync.done 的 mtime 检测（只有"完成"事件）。
  const logOk = await tailSyncLog();
  if (!logOk) {
    try {
      const st = await stat(SYNC_DONE_PATH);
      const mtime = st.mtimeMs;
      if (lastSyncDoneMtime && mtime > lastSyncDoneMtime) {
        events.push({ t: now, label: 'sync.done', kind: 'auto' });
      }
      lastSyncDoneMtime = mtime;
    } catch {
      // 文件不存在则跳过
    }
  }
}

// ---------- sync.log tail：自动标记每轮同步 ----------
let syncLogOffset = -1; // -1 = 未初始化：启动时跳到末尾，只看新事件
let syncLogPartial = '';

async function tailSyncLog() {
  let st;
  try {
    st = await stat(SYNC_LOG_PATH);
  } catch {
    return false;
  }
  if (syncLogOffset < 0 || st.size < syncLogOffset) {
    // 首次启动或日志被轮转截断：跳到末尾
    syncLogOffset = st.size;
    syncLogPartial = '';
    return true;
  }
  if (st.size === syncLogOffset) return true;

  const fh = await open(SYNC_LOG_PATH, 'r');
  try {
    const len = st.size - syncLogOffset;
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, syncLogOffset);
    syncLogOffset = st.size;
    const lines = (syncLogPartial + buf.toString('utf8')).split('\n');
    syncLogPartial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const t = entry.ts ? Date.parse(entry.ts) : Date.now();
      if (entry.event === 'signal_sync_start') {
        const who = entry.role ? ` ${entry.role}` : '';
        events.push({
          t,
          label: `同步开始(${entry.reason}${who})`,
          kind: 'start',
        });
      } else if (entry.event === 'signal_sync_done') {
        const secs =
          entry.durationMs != null
            ? ` ${(entry.durationMs / 1000).toFixed(1)}s`
            : '';
        events.push({ t, label: `同步完成(${entry.reason}${secs})`, kind: 'auto' });
      } else if (entry.event === 'signal_sync_error') {
        events.push({ t, label: `同步出错(${entry.reason})`, kind: 'auto' });
      } else if (entry.event === 'cpu_phase') {
        const name = entry.source ? `${entry.phase}:${entry.source}` : entry.phase;
        const cpuMs = Number(entry.cpuMs) || 0;
        const wallMs = Number(entry.wallMs) || 0;
        const role = entry.role || '';
        phases.push({
          t,
          phase: entry.phase,
          source: entry.source || '',
          pid: entry.pid,
          role,
          wallMs,
          cpuMs,
        });
        if (phases.length > 400) phases.splice(0, phases.length - 400);
        // 只把吃 CPU 的阶段画成竖线，避免 skip/cache 把图刷满
        if (cpuMs >= 15) {
          events.push({
            t,
            label: `${name} ${cpuMs}ms cpu`,
            kind: 'phase',
          });
        }
      }
    }
  } finally {
    await fh.close();
  }
  return true;
}

setInterval(() => void sampleOnce(), INTERVAL_MS);
void sampleOnce();

// ---------- HTTP server ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/api/state') {
    const since = Number(url.searchParams.get('since') || '0');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        intervalMs: INTERVAL_MS,
        pattern: PATTERN.source,
        samples: samples.filter((s) => s.t > since),
        events: events.filter((e) => e.t > since),
        phases: phases.filter((p) => p.t > since),
      }),
    );
    return;
  }

  if (url.pathname === '/api/mark' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let label = 'mark';
      try {
        label = JSON.parse(body || '{}').label || 'mark';
      } catch {}
      events.push({ t: Date.now(), label, kind: 'manual' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});

server.listen(PORT, () => {
  console.log(`[monitor] 采样间隔 ${INTERVAL_MS}ms，匹配正则: ${PATTERN.source}`);
  console.log(`[monitor] sync.done 监听: ${SYNC_DONE_PATH}`);
  if (LOG_FILE) console.log(`[monitor] 采样落盘: ${LOG_FILE}`);
  console.log(`[monitor] 打开 http://localhost:${PORT} 查看实时曲线`);
});

// ---------- 前端页面（零依赖，canvas 手绘曲线） ----------
const PAGE_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Juejin Usage · CPU / 内存监控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 24px 40px;
    background: #0d1017; color: #e6e9ef;
    font: 13px/1.5 -apple-system, "SF Pro Text", "PingFang SC", sans-serif;
  }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: #7c8494; font-size: 12px; margin-bottom: 16px; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  button, select {
    background: #1a2030; color: #e6e9ef; border: 1px solid #2a3247;
    border-radius: 6px; padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  button:hover { background: #232b40; }
  button.primary { background: #2b5cd9; border-color: #2b5cd9; }
  button.primary:hover { background: #3468e8; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
  .card { background: #141927; border: 1px solid #222b3f; border-radius: 10px; padding: 12px 14px; }
  .card .k { color: #7c8494; font-size: 11px; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 2px; font-variant-numeric: tabular-nums; }
  .card .v small { font-size: 12px; color: #7c8494; font-weight: 400; }
  .chartbox { background: #141927; border: 1px solid #222b3f; border-radius: 10px; padding: 12px 14px 6px; margin-bottom: 14px; }
  .chartbox h2 { font-size: 13px; margin: 0 0 6px; font-weight: 600; color: #aab2c4; }
  canvas { width: 100%; height: 220px; display: block; }
  .legend { display: flex; gap: 14px; font-size: 11px; color: #8a93a6; margin-top: 4px; padding-bottom: 4px; }
  .legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: right; padding: 6px 10px; border-bottom: 1px solid #1d2436; font-size: 12px; }
  th:first-child, td:first-child { text-align: left; }
  th { color: #7c8494; font-weight: 500; }
  .tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; }
  .tag.main { background: #2b5cd930; color: #7ea4ff; }
  .tag.renderer { background: #18a05830; color: #4fd48b; }
  .tag.gpu { background: #b3831230; color: #e8b64c; }
  .tag.sync { background: #e85c7b30; color: #ff8aa5; }
  .tag.utility, .tag.plugin, .tag.other { background: #6b729030; color: #9aa2b8; }
  .cmd { font-size: 10px; color: #6b7290; max-width: 520px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .empty { color: #7c8494; padding: 30px; text-align: center; }
</style>
</head>
<body>
<h1>Juejin Usage · CPU / 内存监控</h1>
<div class="sub" id="meta">连接中…</div>

<div class="toolbar">
  <button class="primary" onclick="mark()">📍 标记当前时刻（如：点了同步）</button>
  <select id="window" onchange="draw()">
    <option value="60">最近 1 分钟</option>
    <option value="300" selected>最近 5 分钟</option>
    <option value="900">最近 15 分钟</option>
    <option value="3600">最近 1 小时</option>
    <option value="0">全部</option>
  </select>
  <button onclick="paused=!paused;this.textContent=paused?'▶ 继续':'⏸ 暂停'">⏸ 暂停</button>
</div>

<div class="cards">
  <div class="card"><div class="k">当前 CPU（全部进程合计）</div><div class="v" id="cpuNow">–</div></div>
  <div class="card"><div class="k">窗口内 CPU 峰值</div><div class="v" id="cpuPeak">–</div></div>
  <div class="card"><div class="k">窗口内 CPU 均值</div><div class="v" id="cpuAvg">–</div></div>
  <div class="card"><div class="k">当前内存（RSS 合计）</div><div class="v" id="memNow">–</div></div>
  <div class="card"><div class="k">窗口内内存峰值</div><div class="v" id="memPeak">–</div></div>
</div>

<div class="chartbox">
  <h2>CPU 占用（%，100% = 一个核）</h2>
  <canvas id="cpuChart"></canvas>
  <div class="legend">
    <span><i style="background:#7ea4ff"></i>合计</span>
    <span><i style="background:#4f7dff"></i>主进程</span>
    <span><i style="background:#ff8aa5"></i>sync worker</span>
    <span><i style="background:#4fd48b"></i>渲染进程</span>
    <span><i style="background:#e8b64c"></i>GPU</span>
    <span><i style="background:#f2a94c"></i>│ 同步开始</span>
    <span><i style="background:#e85c7b"></i>│ 同步完成</span>
    <span><i style="background:#7ee0d0"></i>│ CPU 阶段 ≥15ms</span>
    <span><i style="background:#c58cff"></i>│ 手动标记</span>
  </div>
</div>

<div class="chartbox">
  <h2>内存 RSS（MB）</h2>
  <canvas id="memChart"></canvas>
</div>

<div class="chartbox">
  <h2>进程明细（实时）</h2>
  <table>
    <thead><tr><th>PID</th><th>类型</th><th>CPU %</th><th>内存 MB</th><th>命令</th></tr></thead>
    <tbody id="procBody"><tr><td colspan="5" class="empty">等待数据…</td></tr></tbody>
  </table>
</div>

<div class="chartbox">
  <h2>CPU 阶段打点（process.cpuUsage，最近窗口）</h2>
  <table>
    <thead><tr><th>时间</th><th>阶段</th><th>源</th><th>角色</th><th>PID</th><th>墙钟 ms</th><th>CPU ms</th></tr></thead>
    <tbody id="phaseBody"><tr><td colspan="7" class="empty">等待 sync.log 打点…</td></tr></tbody>
  </table>
</div>

<script>
let samples = [], events = [], phases = [], lastT = 0, paused = false, intervalMs = 300;

async function poll() {
  try {
    const res = await fetch('/api/state?since=' + lastT);
    const data = await res.json();
    intervalMs = data.intervalMs;
    samples.push(...data.samples);
    events.push(...data.events);
    if (data.phases) phases.push(...data.phases);
    if (samples.length > 20000) samples.splice(0, samples.length - 20000);
    if (phases.length > 800) phases.splice(0, phases.length - 800);
    if (data.samples.length) lastT = data.samples[data.samples.length - 1].t;
    document.getElementById('meta').textContent =
      '匹配: ' + data.pattern + ' ｜ 采样间隔 ' + intervalMs + 'ms ｜ 样本数 ' + samples.length +
      (samples.length && samples[samples.length-1].procs.length === 0 ? ' ｜ ⚠️ 未匹配到进程，应用没在运行？' : '');
    if (!paused) draw();
  } catch (e) { /* server 重启时静默重试 */ }
  setTimeout(poll, intervalMs);
}

async function mark() {
  const label = prompt('标记名称', '点同步') || '点同步';
  await fetch('/api/mark', { method: 'POST', body: JSON.stringify({ label }) });
}

function windowed() {
  const sec = Number(document.getElementById('window').value);
  if (!sec) return samples;
  const cutoff = Date.now() - sec * 1000;
  return samples.filter(s => s.t >= cutoff);
}

function fmtTime(t) {
  const d = new Date(t);
  return d.toTimeString().slice(0, 8);
}

function drawChart(canvas, rows, seriesDefs, unit) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight || 220;
  canvas.width = W * dpr; canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  const padL = 44, padR = 10, padT = 8, padB = 20;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  if (rows.length < 2) return;

  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  let vMax = 0;
  for (const r of rows) for (const s of seriesDefs) vMax = Math.max(vMax, s.get(r));
  vMax = vMax <= 0 ? 1 : vMax * 1.15;

  const x = t => padL + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
  const y = v => padT + plotH - (v / vMax) * plotH;

  // 网格 + Y 轴
  ctx.strokeStyle = '#1d2436'; ctx.fillStyle = '#5d6579';
  ctx.font = '10px -apple-system'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (vMax / 4) * i, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W - padR, yy); ctx.stroke();
    ctx.fillText(Math.round(v) + unit, padL - 6, yy + 3);
  }
  // X 轴时间
  ctx.textAlign = 'center';
  for (let i = 0; i <= 4; i++) {
    const t = t0 + ((t1 - t0) / 4) * i;
    ctx.fillText(fmtTime(t), x(t), H - 6);
  }

  // 事件竖线
  const EVENT_COLORS = { auto: '#e85c7b', start: '#f2a94c', manual: '#c58cff', phase: '#7ee0d0' };
  for (const e of events) {
    if (e.t < t0 || e.t > t1) continue;
    const color = EVENT_COLORS[e.kind] || '#c58cff';
    ctx.strokeStyle = color + '88';
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(e.t), padT); ctx.lineTo(x(e.t), padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.save();
    ctx.translate(x(e.t) + 3, padT + 10);
    ctx.textAlign = 'left';
    ctx.fillText(e.label, 0, 0);
    ctx.restore();
  }

  // 曲线
  for (const s of seriesDefs) {
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.2;
    ctx.beginPath();
    rows.forEach((r, i) => {
      const xx = x(r.t), yy = y(s.get(r));
      i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  }
}

const TYPE_NAMES = { main: '主进程', renderer: '渲染', gpu: 'GPU', sync: 'sync worker', utility: 'Helper', plugin: '插件', other: '其他' };

function draw() {
  const rows = windowed();
  drawChart(document.getElementById('cpuChart'), rows, [
    { get: r => r.cpu.total, color: '#7ea4ff', width: 1.8 },
    { get: r => r.cpu.main, color: '#4f7dff' },
    { get: r => r.cpu.sync || 0, color: '#ff8aa5', width: 1.6 },
    { get: r => r.cpu.renderer, color: '#4fd48b' },
    { get: r => r.cpu.gpu, color: '#e8b64c' },
  ], '%');
  drawChart(document.getElementById('memChart'), rows, [
    { get: r => r.mem.total, color: '#7ea4ff', width: 1.8 },
    { get: r => r.mem.main, color: '#4f7dff' },
    { get: r => r.mem.renderer, color: '#4fd48b' },
  ], '');

  if (rows.length) {
    const last = rows[rows.length - 1];
    const cpus = rows.map(r => r.cpu.total);
    const mems = rows.map(r => r.mem.total);
    document.getElementById('cpuNow').innerHTML = last.cpu.total + '<small> %</small>';
    document.getElementById('cpuPeak').innerHTML = Math.max(...cpus).toFixed(1) + '<small> %</small>';
    document.getElementById('cpuAvg').innerHTML = (cpus.reduce((a,b)=>a+b,0)/cpus.length).toFixed(1) + '<small> %</small>';
    document.getElementById('memNow').innerHTML = last.mem.total.toFixed(0) + '<small> MB</small>';
    document.getElementById('memPeak').innerHTML = Math.max(...mems).toFixed(0) + '<small> MB</small>';

    const body = document.getElementById('procBody');
    if (last.procs.length) {
      body.innerHTML = last.procs
        .slice().sort((a, b) => b.cpu - a.cpu)
        .map(p => '<tr><td>' + p.pid + '</td><td><span class="tag ' + p.type + '">' +
          (TYPE_NAMES[p.type] || p.type) + '</span></td><td>' + p.cpu.toFixed(1) +
          '</td><td>' + p.memMB.toFixed(0) + '</td><td class="cmd" title="' +
          (p.cmd || '').replace(/"/g,'&quot;') + '">' + (p.cmd || '') + '</td></tr>').join('');
    } else {
      body.innerHTML = '<tr><td colspan="5" class="empty">未匹配到进程</td></tr>';
    }

    const cutoff = rows[0].t;
    const phaseRows = phases.filter(p => p.t >= cutoff).slice(-40).reverse();
    const phaseBody = document.getElementById('phaseBody');
    if (phaseRows.length) {
      phaseBody.innerHTML = phaseRows.map(p => {
        const hot = p.cpuMs >= 15 ? ' style="color:#ff8aa5;font-weight:600"' : '';
        return '<tr><td>' + fmtTime(p.t) + '</td><td>' + p.phase + '</td><td>' +
          (p.source || '–') + '</td><td>' + (p.role || '–') + '</td><td>' +
          (p.pid || '–') + '</td><td>' + p.wallMs + '</td><td' + hot + '>' +
          p.cpuMs + '</td></tr>';
      }).join('');
    } else {
      phaseBody.innerHTML = '<tr><td colspan="7" class="empty">窗口内暂无阶段打点</td></tr>';
    }
  }
}

window.addEventListener('resize', draw);
poll();
</script>
</body>
</html>`;
