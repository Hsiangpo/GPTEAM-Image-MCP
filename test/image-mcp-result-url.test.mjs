import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { generateImage } from '../lib/image-mcp/image.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lAQcIgAAAABJRU5ErkJggg==',
  'base64'
);

test('generateImage securely downloads a public HTTPS image result', async () => {
  const fixture = resultURLFixture([{ body: PNG_1X1 }]);
  const outputPath = path.join(fixture.tmp, 'grok.png');

  const result = await generateImage({ prompt: '画一只猫', output_path: outputPath }, fixture.options);

  assert.deepEqual(fs.readFileSync(outputPath), PNG_1X1);
  assert.equal(result.mime_type, 'image/png');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].url, 'https://cdn.example.test/generated.png');
  assert.equal(fixture.requests[0].options.method, 'GET');
  assert.equal(fixture.requests[0].options.headers.Authorization, undefined);
  const pinned = await invokePinnedLookup(fixture.requests[0].options.lookup);
  assert.deepEqual(pinned, { address: '93.184.216.34', family: 4 });
});

test('generateImage falls back across one vetted DNS snapshot without replaying image generation', async () => {
  const fixture = resultURLFixture([
    { requestError: new Error('first CDN address is unreachable') },
    { body: PNG_1X1 }
  ], {
    lookup: async (hostname) => {
      fixture.lookups.push(hostname);
      return [
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        { address: '93.184.216.34', family: 4 }
      ];
    }
  });
  const outputPath = path.join(fixture.tmp, 'grok-dns-fallback.png');

  const result = await generateImage({ prompt: '画一只猫', output_path: outputPath }, fixture.options);

  assert.equal(result.mime_type, 'image/png');
  assert.equal(fixture.apiCalls(), 1);
  assert.deepEqual(fixture.lookups, ['cdn.example.test']);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(await invokePinnedLookup(fixture.requests[0].options.lookup), {
    address: '2606:2800:220:1:248:1893:25c8:1946', family: 6
  });
  assert.deepEqual(await invokePinnedLookup(fixture.requests[1].options.lookup), {
    address: '93.184.216.34', family: 4
  });
});

test('generateImage falls back when a vetted address breaks while streaming the result body', async () => {
  const fixture = resultURLFixture([
    { streamError: new Error('first CDN response stream broke') },
    { body: PNG_1X1 }
  ], {
    lookup: async () => [
      { address: '93.184.216.35', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ]
  });

  const result = await generateImage({ prompt: '画一只猫' }, fixture.options);

  assert.equal(result.mime_type, 'image/png');
  assert.equal(fixture.apiCalls(), 1);
  assert.equal(fixture.requests.length, 2);
});

test('generateImage tunnels a vetted result address through the configured HTTPS proxy', async () => {
  const fixture = resultURLFixture([], {
    proxyURL: 'http://127.0.0.1:7897',
    proxyRequest: async (url, target, proxyURL) => {
      fixture.proxyRequests.push({ url: String(url), target, proxyURL });
      return {
        stream: Readable.from([PNG_1X1]),
        contentType: 'image/png',
        contentLength: PNG_1X1.length
      };
    }
  });

  const result = await generateImage({ prompt: '画一只猫' }, fixture.options);

  assert.equal(result.mime_type, 'image/png');
  assert.equal(fixture.apiCalls(), 1);
  assert.equal(fixture.requests.length, 0);
  assert.deepEqual(fixture.proxyRequests, [{
    url: 'https://cdn.example.test/generated.png',
    target: { address: '93.184.216.34', family: 4 },
    proxyURL: 'http://127.0.0.1:7897/'
  }]);
});

test('generateImage pins proxy transport to the vetted IP while preserving TLS and HTTP identity', async () => {
  const proxyTransports = [];
  const fixture = resultURLFixture([], {
    proxyURL: 'http://127.0.0.1:7897',
    proxyTransportRequest: (requestOptions, callback) => {
      proxyTransports.push(requestOptions);
      return successfulRequest(callback, PNG_1X1);
    }
  });

  const result = await generateImage({ prompt: '画一只猫' }, fixture.options);

  assert.equal(result.mime_type, 'image/png');
  assert.equal(fixture.apiCalls(), 1);
  assert.equal(proxyTransports.length, 1);
  assert.equal(proxyTransports[0].hostname, '93.184.216.34');
  assert.equal(proxyTransports[0].servername, 'cdn.example.test');
  assert.equal(proxyTransports[0].headers.Host, 'cdn.example.test');
  assert.equal(proxyTransports[0].headers.Authorization, undefined);
  assert.equal(proxyTransports[0].headers['X-Api-Key'], undefined);
});

test('generateImage rejects private DNS before contacting the configured proxy', async () => {
  let proxyCalls = 0;
  const fixture = resultURLFixture([], {
    proxyURL: 'http://127.0.0.1:7897',
    lookup: async () => [{ address: '192.168.1.20', family: 4 }],
    proxyRequest: async () => {
      proxyCalls += 1;
      throw new Error('proxy must not be contacted');
    }
  });

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_forbidden'
  );
  assert.equal(proxyCalls, 0);
  assert.equal(fixture.apiCalls(), 1);
});

test('generateImage rejects unsupported proxy protocols before result transport', async () => {
  let proxyCalls = 0;
  const fixture = resultURLFixture([], {
    proxyURL: 'socks5://127.0.0.1:1080',
    proxyRequest: async () => {
      proxyCalls += 1;
      throw new Error('unsupported proxy must not be contacted');
    }
  });

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_proxy_invalid'
  );
  assert.equal(proxyCalls, 0);
  assert.equal(fixture.requests.length, 0);
  assert.equal(fixture.apiCalls(), 1);
});

test('generateImage revalidates a proxied redirect before contacting the proxy again', async () => {
  const lookups = [];
  let proxyCalls = 0;
  const fixture = resultURLFixture([], {
    proxyURL: 'http://127.0.0.1:7897',
    lookup: async (hostname) => {
      lookups.push(hostname);
      if (hostname === 'private.example.test') return [{ address: '10.0.0.5', family: 4 }];
      return [{ address: '93.184.216.34', family: 4 }];
    },
    proxyRequest: async () => {
      proxyCalls += 1;
      return { redirect: 'https://private.example.test/result.png' };
    }
  });

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_forbidden'
  );
  assert.deepEqual(lookups, ['cdn.example.test', 'private.example.test']);
  assert.equal(proxyCalls, 1);
  assert.equal(fixture.apiCalls(), 1);
});

test('generateImage rejects result URLs containing credentials before network access', async () => {
  const fixture = resultURLFixture([], { imageURL: 'https://user:password@cdn.example.test/generated.png' });

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_forbidden'
  );
  assert.equal(fixture.lookups.length, 0);
  assert.equal(fixture.requests.length, 0);
});

test('generateImage rejects literal local and private result URLs before network access', async () => {
  for (const imageURL of [
    'https://127.0.0.1/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/image.png',
    'https://10.0.0.1/image.png'
  ]) {
    const fixture = resultURLFixture([], { imageURL });
    await assert.rejects(
      generateImage({ prompt: '画一只猫' }, fixture.options),
      (error) => error.code === 'image_url_forbidden'
    );
    assert.equal(fixture.requests.length, 0);
  }
});

test('generateImage rejects hostnames resolving only to non-public addresses', async () => {
  for (const record of [
    { address: '192.168.1.20', family: 4 },
    { address: '2001:db8::20', family: 6 },
    { address: '3fff::20', family: 6 }
  ]) {
    const fixture = resultURLFixture([], { lookup: async () => [record] });
    await assert.rejects(
      generateImage({ prompt: '画一只猫' }, fixture.options),
      (error) => error.code === 'image_url_forbidden'
    );
    assert.equal(fixture.requests.length, 0);
  }
});

test('generateImage revalidates every redirect and rejects redirects to private targets', async () => {
  const fixture = resultURLFixture([{
    statusCode: 302,
    headers: { location: 'https://127.0.0.1/private.png' },
    body: Buffer.alloc(0)
  }]);

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_forbidden'
  );
  assert.equal(fixture.requests.length, 1);
});

test('generateImage rejects oversized result URLs from both headers and streamed bytes', async () => {
  const declared = resultURLFixture([{
    headers: { 'content-type': 'image/png', 'content-length': String(PNG_1X1.length) },
    body: PNG_1X1
  }], { maxBytes: PNG_1X1.length - 1 });
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, declared.options),
    (error) => error.code === 'image_url_too_large'
  );

  const streamed = resultURLFixture([{
    headers: { 'content-type': 'image/png' },
    chunks: [PNG_1X1.subarray(0, 20), PNG_1X1.subarray(20)]
  }], { maxBytes: PNG_1X1.length - 1 });
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, streamed.options),
    (error) => error.code === 'image_url_too_large'
  );
});

test('generateImage requires an image content type and valid PNG JPEG or WebP bytes', async () => {
  const wrongType = resultURLFixture([{
    headers: { 'content-type': 'text/html' },
    body: Buffer.from('<html>not an image</html>')
  }]);
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, wrongType.options),
    (error) => error.code === 'image_url_content_type_invalid'
  );

  const wrongBytes = resultURLFixture([{
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('not really a png')
  }]);
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, wrongBytes.options),
    (error) => error.code === 'image_mime_invalid'
  );

  const mismatchedType = resultURLFixture([{
    headers: { 'content-type': 'image/jpeg' },
    body: PNG_1X1
  }]);
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, mismatchedType.options),
    (error) => error.code === 'image_url_content_type_invalid'
  );
});

test('generateImage cancels a result URL body with the original request deadline and never replays', async () => {
  const fixture = resultURLFixture([{
    headers: { 'content-type': 'image/png' },
    body: PNG_1X1,
    delayMS: 30
  }], { requestTimeoutMS: 5, maxAttempts: 3 });

  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, fixture.options),
    (error) => error.code === 'image_url_fetch_failed' && error.retryable === false
  );
  assert.equal(fixture.apiCalls(), 1);
});

function resultURLFixture(responses, options = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-result-url-'));
  const requests = [];
  const proxyRequests = [];
  const lookups = [];
  let apiCalls = 0;
  const queue = [...responses];
  const lookup = options.lookup || (async (hostname) => {
    lookups.push(hostname);
    return [{ address: '93.184.216.34', family: 4 }];
  });
  const request = (url, requestOptions, callback) => {
    requests.push({ url: String(url), options: requestOptions });
    const requestEmitter = new EventEmitter();
    requestEmitter.setTimeout = () => requestEmitter;
    requestEmitter.destroy = (error) => queueMicrotask(() => requestEmitter.emit('error', error));
    requestEmitter.end = () => queueMicrotask(() => {
      const next = queue.shift();
      if (!next) {
        requestEmitter.emit('error', new Error('unexpected result URL request'));
        return;
      }
      if (next.requestError) {
        requestEmitter.emit('error', next.requestError);
        return;
      }
      const chunks = next.chunks || [next.body ?? PNG_1X1];
      const response = next.delayMS || next.streamError ? new Readable({ read() {} }) : Readable.from(chunks);
      response.statusCode = next.statusCode || 200;
      response.headers = next.headers || { 'content-type': 'image/png' };
      callback(response);
      if (next.streamError) {
        queueMicrotask(() => response.destroy(next.streamError));
      } else if (next.delayMS) {
        setTimeout(() => {
          for (const chunk of chunks) response.push(chunk);
          response.push(null);
        }, next.delayMS);
      }
    });
    return requestEmitter;
  };
  return {
    tmp,
    requests,
    proxyRequests,
    lookups,
    apiCalls: () => apiCalls,
    options: {
      env: {
        GPTEAM_API_KEY: 'sk-test',
        GPTEAM_BASE_URL: 'https://api.example.test/v1',
        GPTEAM_IMAGE_OUTPUT_DIR: tmp
      },
      maxAttempts: options.maxAttempts || 1,
      requestTimeoutMs: options.requestTimeoutMS,
      resultURLLookup: lookup,
      resultURLRequest: request,
      resultURLProxyURL: options.proxyURL,
      resultURLProxyRequest: options.proxyRequest,
      resultURLProxyTransportRequest: options.proxyTransportRequest,
      resultURLMaxBytes: options.maxBytes,
      fetch: async () => {
        apiCalls += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => 'application/json' },
          json: async () => ({ data: [{ url: options.imageURL || 'https://cdn.example.test/generated.png' }] })
        };
      }
    }
  };
}

function successfulRequest(callback, body) {
  const requestEmitter = new EventEmitter();
  requestEmitter.setTimeout = () => requestEmitter;
  requestEmitter.destroy = (error) => queueMicrotask(() => requestEmitter.emit('error', error));
  requestEmitter.end = () => queueMicrotask(() => {
    const response = Readable.from([body]);
    response.statusCode = 200;
    response.headers = { 'content-type': 'image/png', 'content-length': String(body.length) };
    callback(response);
  });
  return requestEmitter;
}

function invokePinnedLookup(lookup) {
  return new Promise((resolve, reject) => {
    lookup('cdn.example.test', {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}
