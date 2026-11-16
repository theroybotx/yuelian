const transportHeaders = [
  'x-yuelian-channel', 'x-yuelian-time', 'x-yuelian-nonce',
  'x-yuelian-identity', 'x-yuelian-signature', 'content-type',
];
const failure = (status, code) => Response.json({code}, {
  status, headers: {'cache-control': 'no-store'},
});

export async function relay(request, backendBinding) {
  const url = new URL(request.url);
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) return failure(405, 'METHOD_NOT_ALLOWED');
  if (!/^\/v1\/[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(url.pathname)
      || request.url.includes('?') || request.url.includes('#')
      || url.pathname.split('/').includes('testing')) return failure(404, 'NOT_FOUND');
  const channel = request.headers.get('x-yuelian-channel');
  if (channel !== 'standalone') return failure(401, 'AUTH_REQUIRED');
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return failure(415, 'UNSUPPORTED_ENCODING');
  if (request.method !== 'GET'
      && !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
    return failure(415, 'JSON_REQUIRED');
  }
  if (!backendBinding?.fetch) return failure(503, 'BACKEND_UNAVAILABLE');

  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(failure(504, 'BACKEND_TIMEOUT'));
    }, 55000);
  });
  const forward = async () => {
    const chunks = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      const cancel = () => { reader.cancel().catch(() => {}); };
      controller.signal.addEventListener('abort', cancel, {once: true});
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (controller.signal.aborted) return failure(504, 'BACKEND_TIMEOUT');
          if (done) break;
          size += value.byteLength;
          if (size > 65536) {
            cancel();
            return failure(413, 'BODY_TOO_LARGE');
          }
          chunks.push(value);
        }
      } finally {
        controller.signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers();
    for (const name of transportHeaders) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    const upstream = await backendBinding.fetch(new Request('http://127.0.0.1:18797' + url.pathname, {
      method: request.method, headers, ...(request.method !== 'GET' ? {body} : {}),
      redirect: 'manual', signal: controller.signal,
    }));
    if (upstream.status >= 300 && upstream.status < 400
        || upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      upstream.body?.cancel().catch(() => {});
      return failure(502, 'INVALID_BACKEND_RESPONSE');
    }
    const bytes = await upstream.arrayBuffer();
    JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    return new Response(bytes, {
      status: upstream.status,
      headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
    });
  };
  try {
    return await Promise.race([forward(), deadline]);
  } catch {
    return failure(controller.signal.aborted ? 504 : 502,
      controller.signal.aborted ? 'BACKEND_TIMEOUT' : 'BACKEND_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export default {
  fetch(request, env) { return relay(request, env.YUELIAN_BACKEND); },
};
