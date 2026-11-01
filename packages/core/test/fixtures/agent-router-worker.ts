// Exercise the real internal worker with isolated HTTP responses and no account access.
let refreshes = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === '/oauth/token') {
    if (++refreshes > 1) throw new Error('Refresh token spent twice');
    return Response.json({ access_token: 'fake-renewed', refresh_token: 'fake-rotated', expires_in: 3600 });
  }
  const headers = new Headers(init?.headers);
  if (!headers.get('authorization')?.startsWith('Bearer fake-')) throw new Error('Missing native authorization');
  if (url.hostname === 'api.githubcopilot.com') {
    if (url.pathname === '/models') return Response.json({ data: [{ id: 'chat-test' }] });
    if (url.pathname !== '/chat/completions') throw new Error('Incorrect chat endpoint');
    const body = JSON.parse(String(init?.body));
    if (body.model === 'limited') return Response.json({ error: 'quota' }, { status: 429 });
    return Response.json({ id: 'chat-result', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'native chat' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
  }
  if (url.pathname.endsWith('/models')) return Response.json({ models: [{ slug: 'gpt-test', display_name: 'GPT Test' }] });
  if (url.pathname.endsWith('/usage')) { await new Promise(resolve => setTimeout(resolve, 20)); return Response.json({ plan_type: 'pro', rate_limit: { primary_window: { used_percent: 25 } } }); }
  if (url.pathname.endsWith('/responses')) {
    const body = JSON.parse(String(init?.body));
    if (body.model === 'expired') return new Response('{}', { status: 401 });
    if (body.model === 'hold') return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: first\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'response-test', object: 'response', model: 'gpt-test', output: [], usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error('Unexpected network request in native worker test');
};
await import('../../src/agent-router/subscription-worker.js');
