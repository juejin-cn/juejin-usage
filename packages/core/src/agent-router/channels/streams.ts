import { ChannelError, type Json } from './http.js';

/** Pull one bounded SSE event at a time; cancellation closes the HTTP reader. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader(); const decoder = new TextDecoder(); let pending = ''; let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done }); total += value?.length || 0;
      if (total > 32 * 1024 * 1024) throw new ChannelError(502, 'SUBSCRIPTION_RESPONSE_TOO_LARGE');
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        if (boundary.index > 1024 * 1024) throw new ChannelError(502);
        const lines = pending.slice(0, boundary.index).split(/\r?\n/);
        const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        const event = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || '';
        pending = pending.slice(boundary.index + boundary[0].length); if (data) yield { event, data };
      }
      if (pending.length > 1024 * 1024) throw new ChannelError(502);
      if (done) { if (pending.trim()) throw new ChannelError(502, 'SUBSCRIPTION_TRUNCATED_STREAM'); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function* sse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> { for await (const frame of sseEvents(body)) yield frame.data; }
export async function eventResponse(events: AsyncGenerator<Json | string>, cancelSource: () => void = () => {}): Promise<Response> {
  // Read the first frame before sending 200 so early refusals can fail over.
  let first: IteratorResult<Json | string>;
  try { first = await events.next(); } catch (error) {
    cancelSource(); await events.return(undefined); if (!(error instanceof ChannelError)) throw error;
    return Response.json({ error: { message: error.message } }, { status: error.status });
  }
  let initial = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = initial ? first : await events.next(); initial = false;
        if (next.done) { cancelSource(); controller.close(); return; }
        controller.enqueue(Buffer.from(`data: ${typeof next.value === 'string' ? next.value : JSON.stringify(next.value)}\n\n`));
      } catch (error) { cancelSource(); controller.error(error); await events.return(undefined); }
    },
    async cancel() { cancelSource(); await events.return(undefined); },
  }, { highWaterMark: 0 });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
