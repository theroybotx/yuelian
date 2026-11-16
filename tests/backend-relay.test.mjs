import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import worker, {relay} from '../cloudflare/backend-relay.mjs';
import {createTransportAuthenticator, STANDALONE_AUDIENCE} from '../server/src/transport-auth.mjs';

const standaloneSecret = 'synthetic-standalone-secret-'.repeat(3);
const sitesSecret = 'synthetic-sites-secret-'.repeat(3);
const authenticate = createTransportAuthenticator({standaloneSecret, sitesSecret});
const identity = {id: STANDALONE_AUDIENCE, name: '约练访客', emailHash: 'a'.repeat(64), clientKey: 'b'.repeat(64)};
function signed(method = 'GET', path = '/v1/auth/session', body = '') {
  const stamp = String(Date.now()), nonce = randomUUID();
  const encoded = Buffer.from(JSON.stringify(identity)).toString('base64url');
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', standaloneSecret)
    .update([method, path, stamp, nonce, encoded, digest].join('\n')).digest('hex');
  return new Request('https://relay.example' + path, {
    method, ...(method !== 'GET' ? {body} : {}), headers: {
      'x-yuelian-channel': 'standalone', 'x-yuelian-time': stamp, 'x-yuelian-nonce': nonce,
      'x-yuelian-identity': encoded, 'x-yuelian-signature': signature, 'content-type': 'application/json',
    },
  });
}
function backend() {
  const nonces = new Set(), calls = [];
  return {calls, async fetch(request) {
    calls.push(request);
    const bytes = Buffer.from(await request.arrayBuffer());
    try {
      const actor = authenticate({method: request.method, url: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers)}, bytes);
      assert.equal(actor.id, STANDALONE_AUDIENCE);
      if (nonces.has(actor.requestId)) return Response.json({code: 'REPLAY'}, {status: 401});
      nonces.add(actor.requestId);
      return new Response('{ "ok": true, "名字": "约练" }\n', {status: 201, headers: {
        'content-type': 'application/json; charset=utf-8', 'set-cookie': 'secret=1',
        location: 'https://untrusted.example', 'access-control-allow-origin': '*',
      }});
    } catch (error) {
      if (error.status !== 401) throw error;
      return Response.json({code: error.code}, {status: 401});
    }
  }};
}

test('signed UTF-8 bytes and paths reach the real authenticator unchanged for all methods', async () => {
  for (const method of ['GET', 'POST', 'PATCH']) {
    const binding = backend();
    const body = method === 'GET' ? '' : '{ "name": "约练 🏸", "n": 1 }\n';
    const path = method === 'GET' ? '/v1/auth/session' : '/v1/workspaces/abc-123/plans/generate';
    const request = signed(method, path, body);
    const before = Object.fromEntries(request.headers);
    const response = await worker.fetch(request, {YUELIAN_BACKEND: binding});
    assert.equal(response.status, 201);
    assert.equal(await response.text(), '{ "ok": true, "名字": "约练" }\n');
    assert.deepEqual(Object.fromEntries(response.headers), {'cache-control': 'no-store', 'content-type': 'application/json'});
    assert.equal(binding.calls.length, 1);
    assert.equal(binding.calls[0].url, 'http://127.0.0.1:18797' + path);
    assert.equal(binding.calls[0].redirect, 'manual');
    assert.deepEqual(Object.fromEntries(binding.calls[0].headers), before);
  }
});

test('body, path, method and signature tampering are rejected by backend HMAC', async () => {
  const original = signed('POST', '/v1/auth/session', '{"name":"约练"}');
  for (const request of [
    new Request(original, {body: '{"name":"改动"}'}),
    new Request('https://relay.example/v1/auth/logout', {method: 'POST', headers: original.headers, body: '{"name":"约练"}'}),
    new Request(original, {method: 'PATCH', body: '{"name":"约练"}'}),
  ]) {
    assert.equal((await relay(request, backend())).status, 401);
  }
  const broken = signed(); broken.headers.set('x-yuelian-signature', '0'.repeat(64));
  assert.equal((await relay(broken, backend())).status, 401);
  assert.equal((await relay(new Request('https://relay.example/v1/auth/session'), backend())).status, 401);
});

test('replay state belongs to isolated test backend, and errors preserve status and JSON', async () => {
  const request = signed(), copy = request.clone(), isolated = request.clone(), binding = backend();
  assert.equal((await relay(request, binding)).status, 201);
  const replay = await relay(copy, binding);
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), {code: 'REPLAY'});
  assert.equal((await relay(isolated, backend())).status, 201);
});

test('only transport headers and content-type pass; credentials and caller routing are stripped', async () => {
  const request = signed();
  for (const [key, value] of Object.entries({authorization: 'Bearer fake', cookie: 'session=fake',
    host: 'attacker.example', 'content-length': '999', 'x-forwarded-for': '1.2.3.4',
    'cf-connecting-ip': '1.2.3.4', 'x-yuelian-client-key': 'spoofed', origin: 'https://attacker.example'})) {
    request.headers.set(key, value);
  }
  const binding = backend();
  assert.equal((await relay(request, binding)).status, 201);
  assert.deepEqual([...binding.calls[0].headers.keys()].sort(), [
    'content-type', 'x-yuelian-channel', 'x-yuelian-identity', 'x-yuelian-nonce', 'x-yuelian-signature', 'x-yuelian-time',
  ]);
});

test('rejects noncanonical paths, queries, testing endpoints and unsupported methods without fetch', async () => {
  const binding = {fetch() { assert.fail('invalid request must not reach backend'); }};
  for (const path of ['/v1', '/v1/', '/api/auth/session', '/v1/testing/session', '/v1/a/testing/b',
    '/v1/auth/session?', '/v1/auth/session?x=1', '/v1/auth/session#fragment',
    '/v1/auth//session', '/v1/auth/session/', '/v1/Auth/session', '/v1/auth%2fsession',
    '/v1/auth%5csession', '/v1/%2e%2e/other', '/v1/auth/%2573ession']) {
    assert.equal((await relay(new Request('https://relay.example' + path), binding)).status, 404, path);
  }
  for (const method of ['HEAD', 'OPTIONS', 'PUT', 'DELETE']) {
    assert.equal((await relay(new Request('https://relay.example/v1/auth/session', {method}), binding)).status, 405);
  }
});

test('65536-byte bound uses actual stream bytes and rejects UTF-8 overflow before fetch', async () => {
  const atLimit = Buffer.from('约'.repeat(21844) + 'abcd');
  assert.equal(atLimit.byteLength, 65536);
  assert.equal((await relay(signed('POST', '/v1/auth/session', atLimit), backend())).status, 201);
  const binding = {fetch() { assert.fail('oversized request must not be sent'); }};
  assert.equal((await relay(signed('POST', '/v1/auth/session', Buffer.concat([atLimit, Buffer.from('x')])), binding)).status, 413);
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {
    controller.enqueue(new Uint8Array(40000)); controller.enqueue(new Uint8Array(25537));
  }, cancel() { cancelled = true; }});
  const request = new Request('https://relay.example/v1/auth/session', {
    method: 'POST', body: stream, duplex: 'half', headers: {'content-length': '1', 'content-type': 'application/json', 'x-yuelian-channel': 'standalone'},
  });
  assert.equal((await relay(request, binding)).status, 413);
  assert.equal(cancelled, true);
});

test('redirect, malformed JSON, non-JSON and transport failures never trigger a retry', async () => {
  for (const result of [
    () => new Response('{}', {status: 302, headers: {'content-type': 'application/json', location: 'https://elsewhere.example'}}),
    () => new Response('html', {headers: {'content-type': 'text/html'}}),
    () => new Response('not json', {headers: {'content-type': 'application/json'}}),
    () => new Response('{}', {headers: {'content-type': 'application/jsonp'}}),
    () => { throw new Error('private connection lost'); },
  ]) {
    let calls = 0;
    const response = await relay(signed(), {fetch() { calls++; return result(); }});
    assert.equal(response.status, 502);
    assert.equal(calls, 1);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await relay(signed(), undefined)).status, 503);
});

test('55-second total deadline includes upload, upstream fetch and response body', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  let uploadCancelled = false;
  const upload = new Request('https://relay.example/v1/auth/session', {method: 'POST', duplex: 'half',
    headers: {'content-type': 'application/json', 'x-yuelian-channel': 'standalone'},
    body: new ReadableStream({cancel() { uploadCancelled = true; }})});
  const uploadResult = relay(upload, {fetch() { assert.fail('unfinished upload'); }});
  t.mock.timers.tick(55000);
  assert.equal((await uploadResult).status, 504);
  assert.equal(uploadCancelled, true);
  let calls = 0, upstreamSignal;
  const fetchResult = relay(signed(), {fetch(request) {
    calls++; upstreamSignal = request.signal; return new Promise(() => {});
  }});
  t.mock.timers.tick(55000);
  assert.equal((await fetchResult).status, 504);
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(calls, 1);
  const responseResult = relay(signed(), {fetch() {
    return new Response(new ReadableStream(), {headers: {'content-type': 'application/json'}});
  }});
  await Promise.resolve();
  t.mock.timers.tick(55000);
  assert.equal((await responseResult).status, 504);
});

test('other transport channels and encoded or non-JSON writes never reach the backend', async () => {
  const binding = {fetch() { assert.fail('unsupported transport must not be forwarded'); }};
  const otherChannel = signed(); otherChannel.headers.set('x-yuelian-channel', 'sites');
  assert.equal((await relay(otherChannel, binding)).status, 401);
  const compressed = signed('POST', '/v1/auth/session', '{}'); compressed.headers.set('content-encoding', 'gzip');
  assert.equal((await relay(compressed, binding)).status, 415);
  const text = signed('POST', '/v1/auth/session', '{}'); text.headers.set('content-type', 'text/plain');
  assert.equal((await relay(text, binding)).status, 415);
});

test('a valid Sites signature without a channel cannot enter the standalone relay', async () => {
  const path = '/v1/auth/session', stamp = String(Date.now()), nonce = randomUUID();
  const siteIdentity = {id: 'sites:user', name: 'Site visitor', emailHash: 'c'.repeat(64)};
  const encoded = Buffer.from(JSON.stringify(siteIdentity)).toString('base64url');
  const digest = createHash('sha256').update('').digest('hex');
  const signature = createHmac('sha256', sitesSecret)
    .update(['GET', path, stamp, nonce, encoded, digest].join('\n')).digest('hex');
  const headers = {'x-yuelian-time': stamp, 'x-yuelian-nonce': nonce,
    'x-yuelian-identity': encoded, 'x-yuelian-signature': signature};
  assert.equal(authenticate({method: 'GET', url: path, headers}, Buffer.alloc(0)).channel, 'sites');
  let calls = 0;
  const response = await relay(new Request('https://relay.example' + path, {headers}), {
    async fetch(request) {
      calls++;
      authenticate({method: request.method, url: new URL(request.url).pathname,
        headers: Object.fromEntries(request.headers)}, Buffer.from(await request.arrayBuffer()));
      return Response.json({authenticated: true});
    },
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test('deployment config fixes the service, worker and entrypoint without secrets or assets', async () => {
  const config = JSON.parse(await readFile(new URL('../cloudflare/wrangler-backend-relay.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config, {
    name: 'yuelian-vercel-backend', account_id: '07e8a4b09287f3ce9c12d797105bf452', main: 'backend-relay.mjs',
    compatibility_date: '2026-05-15', workers_dev: true, preview_urls: false,
    vpc_services: [{binding: 'YUELIAN_BACKEND', service_id: '01a199df-d580-7c31-956d-5882481ac045'}],
  });
});
