import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProxyAwareFetch, proxyURLFor } from '../lib/image-mcp/proxy-fetch.js';

test('proxyURLFor respects protocol-specific proxy variables and HTTP ALL_PROXY fallback', () => {
  assert.equal(proxyURLFor('https://api.example.test/v1', {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:8080'
  }), 'http://127.0.0.1:7890');
  assert.equal(proxyURLFor('http://api.example.test/v1', {
    HTTPS_PROXY: 'http://127.0.0.1:7890',
    HTTP_PROXY: 'http://127.0.0.1:8080'
  }), 'http://127.0.0.1:8080');
  assert.equal(proxyURLFor('https://api.example.test/v1', {
    ALL_PROXY: 'http://127.0.0.1:7890'
  }), 'http://127.0.0.1:7890');
  assert.equal(proxyURLFor('https://api.example.test/v1', {
    https_proxy: '127.0.0.1:7890'
  }), 'https://127.0.0.1:7890');
});

test('proxyURLFor honors NO_PROXY wildcard, exact hosts, suffixes, and ports', () => {
  const base = { HTTPS_PROXY: 'http://127.0.0.1:7890' };
  assert.equal(proxyURLFor('https://api.example.test/v1', { ...base, NO_PROXY: '*' }), '');
  assert.equal(proxyURLFor('https://api.example.test/v1', { ...base, NO_PROXY: 'api.example.test' }), '');
  assert.equal(proxyURLFor('https://api.example.test/v1', { ...base, NO_PROXY: '.example.test' }), '');
  assert.equal(proxyURLFor('https://api.example.test:8443/v1', {
    ...base, NO_PROXY: 'api.example.test:8443'
  }), '');
  assert.equal(proxyURLFor('https://api.example.test:443/v1', {
    ...base, NO_PROXY: 'api.example.test:8443'
  }), 'http://127.0.0.1:7890');
});

test('createProxyAwareFetch injects and reuses a dispatcher only for proxied requests', async () => {
  const calls = [];
  const dispatchers = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  const wrapped = createProxyAwareFetch({
    fetch: fetchImpl,
    env: {
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      NO_PROXY: 'local.example.test'
    },
    createDispatcher(proxyURL) {
      const dispatcher = { proxyURL };
      dispatchers.push(dispatcher);
      return dispatcher;
    }
  });

  await wrapped('https://api.example.test/v1', { method: 'GET' });
  await wrapped('https://api.example.test/v2', { method: 'POST' });
  await wrapped('https://local.example.test/v1', { method: 'GET' });

  assert.equal(dispatchers.length, 1);
  assert.equal(calls[0].init.dispatcher, dispatchers[0]);
  assert.equal(calls[1].init.dispatcher, dispatchers[0]);
  assert.equal(calls[2].init.dispatcher, undefined);
});

test('createProxyAwareFetch preserves an explicit caller dispatcher', async () => {
  const explicit = { kind: 'explicit' };
  let received;
  const wrapped = createProxyAwareFetch({
    fetch: async (_url, init) => {
      received = init.dispatcher;
      return { ok: true, status: 200 };
    },
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    createDispatcher: () => ({ kind: 'proxy' })
  });
  await wrapped('https://api.example.test/v1', { dispatcher: explicit });
  assert.equal(received, explicit);
});

test('createProxyAwareFetch bounds and closes cached proxy dispatchers', async () => {
  const env = { HTTPS_PROXY: 'http://127.0.0.1:7001' };
  const cache = new Map();
  const created = [];
  const closed = [];
  const wrapped = createProxyAwareFetch({
    fetch: async () => ({ ok: true, status: 200 }),
    env,
    dispatcherCache: cache,
    maxDispatchers: 2,
    createDispatcher(proxyURL) {
      const dispatcher = {
        proxyURL,
        close() {
          closed.push(proxyURL);
        }
      };
      created.push(dispatcher);
      return dispatcher;
    }
  });

  await wrapped('https://api.example.test/one');
  env.HTTPS_PROXY = 'http://127.0.0.1:7002';
  await wrapped('https://api.example.test/two');
  env.HTTPS_PROXY = 'http://127.0.0.1:7003';
  await wrapped('https://api.example.test/three');

  assert.equal(cache.size, 2);
  assert.deepEqual(closed, ['http://127.0.0.1:7001']);

  env.HTTPS_PROXY = 'http://127.0.0.1:7001';
  await wrapped('https://api.example.test/four');
  assert.equal(created.length, 4, '被淘汰的代理必须重新创建 dispatcher');
  assert.deepEqual(closed, ['http://127.0.0.1:7001', 'http://127.0.0.1:7002']);
});

test('createProxyAwareFetch fails fast for an unsupported SOCKS ALL_PROXY URL', async () => {
  let fetchCalls = 0;
  const wrapped = createProxyAwareFetch({
    fetch: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    },
    env: { ALL_PROXY: 'socks5://127.0.0.1:1080' }
  });

  await assert.rejects(
    wrapped('https://api.example.test/v1'),
    (error) => {
      assert.equal(error.code, 'proxy_protocol_unsupported');
      assert.equal(error.retryable, false);
      assert.equal(error.stage, 'configuration');
      return true;
    }
  );
  assert.equal(fetchCalls, 0, '不支持的代理协议必须在网络请求前失败');
});
