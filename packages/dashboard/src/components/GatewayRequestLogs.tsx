import { useCallback, useEffect, useState } from 'react';
import { Button, Modal } from '@heroui/react';
import type { RequestArchive, RouterTrace } from '@juejin-opensource/jusage-core/agent-router';
import { routerRequest } from '@/lib/agent-router';

type Entry = { day: string; id: string; trace?: RouterTrace };
type Page = { requests: Entry[]; next: string | null };
function Body({ title, value }: { title: string; value: RequestArchive['request'] }) {
  let text = value.body.text;
  try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* SSE stays in wire order. */ }
  return <details className="min-w-0 rounded-xl border border-border p-3" open>
    <summary className="cursor-pointer text-sm font-medium">{title} {value.status ? `· HTTP ${value.status}` : ''}</summary>
    {value.path ? <p className="mt-2 break-all font-mono text-xs text-muted">{value.method} {value.path}</p> : null}
    <details className="mt-2 text-xs"><summary className="cursor-pointer text-muted">Headers</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(value.headers, null, 2)}</pre></details>
    {value.body.truncated || value.body.incomplete || value.body.encoding ? <p role="status" className="mt-2 text-xs text-warning">{value.body.truncated ? '内容超过归档上限，已截断。' : ''}{value.body.incomplete ? '响应未完整结束，已保存收到的部分。' : ''}{value.body.encoding ? '压缩正文无法解码。' : ''} 接收 {value.body.bytes.toLocaleString()} 字节</p> : null}
    <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs leading-relaxed">{text || '（无正文）'}</pre>
  </details>;
}
export function GatewayRequestLogs({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [record, setRecord] = useState<RequestArchive | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const load = useCallback(async (before?: string) => {
    setLoading(true); setError('');
    try { const page = await routerRequest<Page>('/archive' + (before ? '?before=' + encodeURIComponent(before) : '')); setRows(old => before ? [...old, ...page.requests] : page.requests); setNext(page.next); }
    catch (error) { setError((error as Error).message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!selected) { setRecord(null); return; }
    let alive = true; setRecord(null); setError('');
    void routerRequest<RequestArchive>(`/archive?day=${selected.day}&id=${selected.id}`).then(value => { if (alive) setRecord(value); }, error => { if (alive) setError((error as Error).message); });
    return () => { alive = false; };
  }, [selected]);
  const download = () => {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `gateway-${record.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const visible = rows.filter(row => !query || JSON.stringify([row.trace?.model, row.trace?.status, row.trace?.reason, row.trace?.protocol, row.trace?.attempts.map(a => a.target), row.day, row.id]).toLowerCase().includes(query.toLowerCase()));
  return <Modal.Backdrop isOpen onOpenChange={open => { if (!open) onClose(); }} variant="opaque">
    <Modal.Container size="lg" scroll="inside">
      <Modal.Dialog aria-label="网关请求日志" className="w-full max-w-5xl p-5">
        <Modal.CloseTrigger aria-label="关闭请求日志" />
        <Modal.Header className="pr-8"><Modal.Heading>{selected ? '请求详情' : '请求日志'}</Modal.Heading></Modal.Header>
        <Modal.Body className="grid min-h-80 gap-3">
          <div className="flex items-center gap-2">
            {selected ? <><Button size="sm" variant="outline" onPress={() => setSelected(null)}>返回列表</Button><Button size="sm" variant="ghost" isDisabled={!record} onPress={download}>导出 JSON</Button></> : <><input aria-label="筛选请求" placeholder="模型、状态码、协议或请求 ID" className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm" value={query} onChange={event => setQuery(event.target.value)} /><Button size="sm" variant="outline" isDisabled={loading} onPress={() => void load()}>刷新</Button></>}
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
          {selected ? !record ? <p role="status" className="text-sm text-muted">{error ? '无法读取请求详情' : '正在读取…'}</p> : <>
            <div className="grid gap-1 rounded-xl bg-surface-secondary p-3 text-xs">
              <p className="break-all font-mono">{record.id}</p>
              <p>{new Date(record.startedAt).toLocaleString()} · {record.trace?.model} · {record.trace?.protocol} · HTTP {record.trace?.status} · {record.trace?.durationMs} ms</p>
              {record.trace?.reason ? <p className="text-danger">{record.trace.reason}</p> : null}
            </div>
            <Body title="客户端请求" value={record.request} />
            {record.upstream.map((attempt, index) => <section key={index} className="grid min-w-0 gap-2">
              <h3 className="mt-2 break-all text-sm font-medium">上游尝试 {index + 1} · {attempt.providerId} · {attempt.protocol} · {String(attempt.model)}</h3>
              <p className="text-xs text-muted">协议转换后、进入渠道适配器的请求</p>
              {attempt.error ? <p className="text-xs text-danger">{attempt.error}</p> : null}
              <Body title="上游请求" value={attempt} />
              {attempt.response ? <Body title="上游响应" value={attempt.response} /> : null}
            </section>)}
            {record.upstreamOmitted ? <p className="text-xs text-warning">另有 {record.upstreamOmitted} 次上游调用超过归档上限。</p> : null}
            <Body title="客户端响应" value={record.response} />
          </> : <>
            <p className="text-xs text-muted">详细正文仅保存在本机；凭据已脱敏。容量上限 1 GiB，超出后清理最早记录。</p>
            {loading && rows.length === 0 ? <p role="status" className="text-sm text-muted">正在读取…</p> : visible.length === 0 ? <p className="py-8 text-center text-sm text-muted">暂无请求记录</p> : <div className="grid gap-1">
              {visible.map(row => <Button key={row.id} variant="ghost" className="h-auto w-full justify-start rounded-lg px-3 py-2 text-left" onPress={() => setSelected(row)}>
                <span className="grid min-w-0 flex-1 gap-1"><span className="truncate text-sm">{row.trace?.model ?? '无模型'} <span className="text-xs text-muted">{row.trace?.protocol}</span></span><span className="truncate text-xs text-muted">{row.trace?.startedAt ? new Date(row.trace.startedAt).toLocaleString() : row.day} · {row.trace?.durationMs} ms{row.trace?.reason ? ` · ${row.trace.reason}` : ''}</span></span>
                <span className={`shrink-0 text-xs ${row.trace && row.trace.status >= 400 ? 'text-danger' : 'text-success'}`}>{row.trace?.status}</span>
              </Button>)}
            </div>}
            {next ? <Button size="sm" variant="outline" isDisabled={loading} onPress={() => void load(next)}>加载更多</Button> : null}
          </>}
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
