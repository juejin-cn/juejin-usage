#!/usr/bin/env python3
"""Bounded macOS Tauri CPU/RSS recording; no server or third-party dependencies.

python3 scripts/monitor-tauri-usage.py --pid APP_PID --duration 1800 --detach
Writes JSONL, CSV, summary.json and a self-contained report.html under output/.
CPU is interval CPU-time delta (100% = one core); RSS sums shared pages too.
WebKit XPC services are attributed by macOS responsibility ID, not PPID.
When launched from a shared terminal, responsibility may include other apps
launched from that terminal: inspect the recorded process identities if needed.
The timer stops the recorder only, never the application.
"""
import argparse
import csv
import ctypes
import datetime as dt
import html
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
GROUPS = ('main', 'sidecar', 'renderer', 'gpu', 'network', 'other')
COLORS = ('#2563eb', '#e11d48', '#16a34a', '#9333ea', '#d97706', '#64748b')


def cpu_seconds(value):
    days, sep, value = value.rpartition('-')
    parts = [float(p) for p in value.split(':')]
    total = 0.0
    for part in parts:
        total = total * 60 + part
    return total + (int(days) * 86400 if sep else 0)


def processes():
    text = subprocess.check_output(
        ['ps', '-axo', 'pid=,ppid=,time=,rss=,lstart=,comm='], text=True,
        timeout=10, env={**os.environ, 'LC_ALL': 'C'})
    result = {}
    for line in text.splitlines():
        parts = line.split(None, 9)
        if len(parts) != 10:
            continue
        pid, parent, cpu, rss = parts[:4]
        result[int(pid)] = dict(pid=int(pid), ppid=int(parent),
                               cpu_seconds=cpu_seconds(cpu), rss_mib=int(rss) / 1024,
                               started=' '.join(parts[4:9]), executable=parts[9])
    return result


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temp.replace(path)


def report(out, samples, metadata, status):
    cpus = [s['cpu']['total'] for s in samples if s['cpu']['total'] is not None]
    mems = [s['rss_mib']['total'] for s in samples]
    summary = dict(status=status, samples=len(samples),
                   start=metadata['start'], updated=dt.datetime.now().astimezone().isoformat(),
                   cpu_mean_percent=sum(cpus) / len(cpus) if cpus else None,
                   cpu_peak_percent=max(cpus) if cpus else None,
                   rss_peak_mib=max(mems) if mems else None,
                   rss_last_mib=mems[-1] if mems else None)
    atomic_json(out / 'summary.json', summary)

    def chart(metric, unit):
        if len(samples) < 2:
            return '<p>等待更多采样点…</p>'
        start, end = samples[0]['epoch'], samples[-1]['epoch']
        maximum = max(1, max((s[metric]['total'] or 0) for s in samples)) * 1.1
        svg = ['<svg viewBox="0 0 1040 280" role="img" aria-label="' + unit + '曲线">']
        for i in range(5):
            y = 240 - 220 * i / 4
            svg.append(f'<path d="M65 {y}H1015" stroke="#e2e8f0"/><text x="58" y="{y+4}" text-anchor="end">{maximum*i/4:.1f}</text>')
            epoch = start + (end - start) * i / 4
            label = dt.datetime.fromtimestamp(epoch).strftime('%H:%M:%S')
            svg.append(f'<text x="{65+950*i/4}" y="265" text-anchor="middle">{label}</text>')
        for key, color in [('total', '#0f172a'), *zip(GROUPS, COLORS)]:
            points = ' '.join(f'{65+950*(s["epoch"]-start)/max(.001,end-start):.2f},{240-220*s[metric][key]/maximum:.2f}'
                              for s in samples if s[metric][key] is not None)
            svg.append(f'<polyline points="{points}" fill="none" stroke="{color}" stroke-width="{2 if key == "total" else 1}"/>')
        return ''.join(svg) + '</svg>'

    detail = ''.join(f'<tr><td>{p["pid"]}</td><td>{p["group"]}</td><td>{p["rss_mib"]:.1f}</td><td>{html.escape(p["executable"])}</td></tr>'
                     for p in samples[-1]['processes']) if samples else ''
    legend = ' · '.join(f'<span style="color:{color}">{key}</span>' for key, color in [('total', '#0f172a'), *zip(GROUPS, COLORS)])
    body = f'''<!doctype html><meta charset="utf-8"><title>Tauri CPU / 内存记录</title>
<style>body{{font:14px system-ui;max-width:1100px;margin:32px auto;padding:0 20px;color:#0f172a}}svg{{width:100%;font:11px system-ui}}section{{border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:20px 0}}td,th{{padding:8px;text-align:left;border-bottom:1px solid #eee}}td:last-child{{word-break:break-all}}pre{{white-space:pre-wrap}}small{{color:#64748b}}</style>
<h1>Tauri CPU / 内存记录</h1><p>{html.escape(metadata['start'])} · {status} · {len(samples)} 个样本 · 每 {metadata['interval_seconds']} 秒采样</p>
<p>{legend}</p><small>CPU：区间累计 CPU 时间差，100% = 一个核；首次或新增进程的首个区间不计 CPU。内存：RSS 合计（MiB），包含共享页重复计数，并非系统内存压力或独占物理内存。WebKit 按 macOS responsibility 归属，同一终端启动的其他应用可能共用该归属；构建器和监测器不计入。此处为 debug 构建。</small>
<section><h2>CPU (%)</h2>{chart('cpu', '%')}</section><section><h2>内存 RSS (MiB)</h2>{chart('rss_mib', 'MiB')}</section>
<section><h2>采样摘要</h2><pre>{html.escape(json.dumps(summary, ensure_ascii=False, indent=2))}</pre></section>
<h2>最新进程</h2><table><tr><th>PID</th><th>类型</th><th>RSS MiB</th><th>程序</th></tr>{detail}</table>
<p>采样时可刷新此文件查看更新；完成后仍可离线打开。原始数据见 samples.jsonl / samples.csv。</p>'''
    temp = out / 'report.tmp'
    temp.write_text(body)
    temp.replace(out / 'report.html')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--duration', type=float, default=1800)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--detach', action='store_true')
    parser.add_argument('--label', default='baseline')
    parser.add_argument('--phase-log', type=Path, help='Optionally archive new sync phase events for the app processes')
    args = parser.parse_args()
    if sys.platform != 'darwin' or args.duration <= 0 or args.interval < 1:
        parser.error('Requires macOS, duration > 0 and interval >= 1 second')
    out = (args.output or ROOT / 'output' / 'tauri-performance' / dt.datetime.now().strftime('%Y%m%d-%H%M%S')).resolve()
    out.mkdir(parents=True, exist_ok=True)
    if args.detach:
        with (out / 'monitor.log').open('a') as log:
            command = [sys.executable, '-u', str(Path(__file__).resolve()),
                '--pid', str(args.pid), '--duration', str(args.duration), '--interval', str(args.interval), '--output', str(out), '--label', args.label]
            if args.phase_log:
                command += ['--phase-log', str(args.phase_log.expanduser().resolve())]
            child = subprocess.Popen(command,
                stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        print(json.dumps(dict(monitor_pid=child.pid, output=str(out))))
        return
    if (out / 'metadata.json').exists():
        parser.error('Output directory already contains a recording; use a new directory')
    responsibility = ctypes.CDLL(None).responsibility_get_pid_responsible_for_pid
    responsibility.argtypes = [ctypes.c_int]
    responsibility.restype = ctypes.c_int
    initial = processes()
    root = initial.get(args.pid)
    if not root or 'jusage-desktop-tauri' not in root['executable']:
        parser.error('PID must be a running jusage-desktop-tauri process')
    responsible = responsibility(args.pid)
    if responsible <= 0:
        raise RuntimeError('Cannot identify WebKit responsibility; refusing incomplete totals')
    start = time.time()
    metadata = dict(start=dt.datetime.now().astimezone().isoformat(), deadline_epoch=start + args.duration,
                    duration_seconds=args.duration, interval_seconds=args.interval,
                    app_pid=args.pid, monitor_pid=os.getpid(), responsibility_pid=responsible,
                    root=root, build='debug', cpu_method='delta cumulative CPU seconds / elapsed seconds * 100',
                    label=args.label,
                    tracked_diff_sha256=hashlib.sha256(subprocess.check_output(['git', 'diff', 'HEAD'], cwd=ROOT)).hexdigest(),
                    webkit_attribution='same responsibility PID; may be shared by apps launched from the same terminal',
                    git_commit=subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip())
    atomic_json(out / 'metadata.json', metadata)
    phase_input = None
    phase_partial = ''
    if args.phase_log and args.phase_log.exists():
        phase_input = args.phase_log.open()
        phase_input.seek(0, 2)

    def archive_phases(pids):
        nonlocal phase_input, phase_partial
        if not args.phase_log:
            return
        # Keep the open descriptor through rotation, drain it, then follow the
        # replacement. Only allow-listed fields and this app's PIDs are stored.
        for _ in range(2):
            if phase_input is None:
                if not args.phase_log.exists():
                    return
                phase_input = args.phase_log.open()
            lines = (phase_partial + phase_input.read()).split('\n')
            phase_partial = lines.pop()
            with (out / 'phases.jsonl').open('a') as sink:
                for line in lines:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue
                    if entry.get('pid') not in pids:
                        continue
                    allowed = ['ts', 'event', 'phase', 'source', 'reason', 'pid', 'role', 'durationMs',
                               'wallMs', 'cpuMs', 'memoryBefore', 'memoryAfter', 'memoryDelta']
                    sink.write(json.dumps({k: entry[k] for k in allowed if k in entry}) + '\n')
            try:
                rotated = args.phase_log.stat().st_ino != os.fstat(phase_input.fileno()).st_ino
            except FileNotFoundError:
                return
            if not rotated:
                return
            phase_input.close()
            phase_input = None
            phase_partial = ''
    samples, previous = [], {}
    previous_tick = None
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    status = 'recording'
    columns = ['timestamp', 'elapsed_seconds', 'process_count', 'cpu_partial'] + [f'cpu_{k}' for k in ('total', *GROUPS)] + [f'rss_mib_{k}' for k in ('total', *GROUPS)]
    with (out / 'samples.jsonl').open('w', buffering=1) as raw, (out / 'samples.csv').open('w', newline='', buffering=1) as csvfile:
        writer = csv.DictWriter(csvfile, fieldnames=columns)
        writer.writeheader()
        while not stopped and time.time() <= start + args.duration:
            all_procs = processes()
            tick, epoch = time.monotonic(), time.time()
            current_root = all_procs.get(args.pid)
            if not current_root or current_root['started'] != root['started']:
                status = 'app-exited'
                break
            owned = {args.pid}
            while True:
                expanded = owned | {p['pid'] for p in all_procs.values() if p['ppid'] in owned}
                if expanded == owned:
                    break
                owned = expanded
            selected = []
            for p in all_procs.values():
                is_webkit = '/WebKit.framework/' in p['executable']
                if p['pid'] not in owned and not (is_webkit and responsibility(p['pid']) == responsible):
                    continue
                exe = p['executable']
                group = ('main' if p['pid'] == args.pid else 'renderer' if 'WebKit.WebContent' in exe else
                         'gpu' if 'WebKit.GPU' in exe else 'network' if 'WebKit.Networking' in exe else
                         'sidecar' if 'jusage-node' in exe else 'other')
                old = previous.get(p['pid'])
                cpu = None
                if old and old['started'] == p['started'] and previous_tick is not None:
                    cpu = max(0, p['cpu_seconds'] - old['cpu_seconds']) / (tick - previous_tick) * 100
                selected.append({**p, 'group': group, 'cpu_percent': cpu})
            cpu = {k: sum(p['cpu_percent'] or 0 for p in selected if p['group'] == k) for k in GROUPS}
            cpu['total'] = sum(cpu.values()) if previous_tick is not None else None
            mem = {k: sum(p['rss_mib'] for p in selected if p['group'] == k) for k in GROUPS}
            mem['total'] = sum(mem.values())
            sample = dict(timestamp=dt.datetime.now().astimezone().isoformat(), epoch=epoch,
                          elapsed_seconds=epoch-start, process_count=len(selected),
                          cpu_partial=any(p['cpu_percent'] is None for p in selected),
                          cpu=cpu, rss_mib=mem, processes=selected)
            raw.write(json.dumps(sample) + '\n')
            writer.writerow({**{k: sample[k] for k in columns[:4]}, **{f'cpu_{k}': v for k, v in cpu.items()}, **{f'rss_mib_{k}': v for k, v in mem.items()}})
            samples.append(sample)
            archive_phases({p['pid'] for s in samples for p in s['processes']})
            previous, previous_tick = {p['pid']: p for p in selected}, tick
            report(out, samples, metadata, status)
            time.sleep(max(0, min(args.interval - (time.monotonic() - tick), start + args.duration - time.time())))
    status = 'stopped' if stopped else 'completed' if status == 'recording' else status
    report(out, samples, metadata, status)
    archive_phases({p['pid'] for s in samples for p in s['processes']})
    if phase_input:
        phase_input.close()
    print(f'{status}: {len(samples)} samples -> {out}', flush=True)


if __name__ == '__main__':
    main()
