import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ImageMCPError } from './errors.js';
import { inspectImageBytes } from './files.js';

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_URL_LENGTH = 8192;
const ACCEPTED_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

export async function downloadImageResultURL(value, options = {}) {
  const maxBytes = positiveInteger(options.maxBytes) || DEFAULT_MAX_BYTES;
  const maxRedirects = nonNegativeInteger(options.maxRedirects, DEFAULT_MAX_REDIRECTS);
  const visited = new Set();
  let current = parseResultURL(value);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const identity = current.href;
    if (visited.has(identity)) throw resultURLError('image_url_redirect_rejected', '图片结果地址发生循环跳转。');
    visited.add(identity);
    const targets = await resolvePublicTargets(current, options.lookup);
    const result = await downloadFromPublicTargets(current, targets, maxBytes, options);
    if (result.redirect) {
      if (redirectCount >= maxRedirects) {
        throw resultURLError('image_url_redirect_rejected', '图片结果地址跳转次数过多。');
      }
      current = parseResultURL(new URL(result.redirect, current).href);
      continue;
    }
    return result.base64;
  }
  throw resultURLError('image_url_redirect_rejected', '图片结果地址跳转次数过多。');
}

function parseResultURL(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw resultURLError('image_url_invalid', '图片结果地址无效。');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw resultURLError('image_url_invalid', '图片结果地址无效。');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw resultURLError('image_url_forbidden', '图片结果地址必须是无凭证的公开 HTTPS 地址。');
  }
  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw resultURLError('image_url_forbidden', '图片结果地址不能指向本机或私有网络。');
  }
  return parsed;
}

async function resolvePublicTargets(url, lookupOption) {
  const hostname = normalizeHostname(url.hostname);
  const family = net.isIP(hostname);
  if (family) {
    if (!isPublicAddress(hostname, family)) throw forbiddenAddressError();
    return [{ address: hostname, family }];
  }
  const lookup = typeof lookupOption === 'function' ? lookupOption : defaultLookup;
  let records;
  try {
    records = await lookup(hostname);
  } catch {
    throw resultURLError('image_url_dns_failed', '图片结果地址解析失败。');
  }
  const normalized = (Array.isArray(records) ? records : [records])
    .map(normalizeLookupRecord)
    .filter(Boolean);
  const targets = [];
  const seen = new Set();
  for (const record of normalized) {
    if (!isPublicAddress(record.address, record.family)) continue;
    const identity = `${record.family}:${record.address}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    targets.push(record);
  }
  if (!targets.length) throw forbiddenAddressError();
  return targets;
}

async function defaultLookup(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

function normalizeLookupRecord(record) {
  const address = String(record && record.address || '').trim();
  const family = Number(record && record.family) || net.isIP(address);
  return family === 4 || family === 6 ? { address, family } : null;
}

async function downloadFromPublicTargets(url, targets, maxBytes, options) {
  let lastFetchError;
  for (const target of targets) {
    try {
      const response = await requestResultURLWithRoute(url, target, options);
      if (response.redirect) return response;
      const declaredType = validateContentType(response.contentType);
      if (response.contentLength > maxBytes) throw tooLargeError(maxBytes);
      const bytes = await readBoundedBody(response.stream, maxBytes, options.signal);
      const inspected = inspectImageBytes(bytes);
      if (inspected.mime_type !== declaredType) {
        throw resultURLError('image_url_content_type_invalid', '图片结果的 Content-Type 与实际图片格式不一致。');
      }
      return { base64: bytes.toString('base64') };
    } catch (error) {
      if (error?.code !== 'image_url_fetch_failed' || options.signal?.aborted) throw error;
      lastFetchError = error;
    }
  }
  throw lastFetchError || resultURLError(
    'image_url_fetch_failed',
    '图片结果地址下载失败，已禁止重放付费生图请求。'
  );
}

function requestResultURLWithRoute(url, target, options) {
  const proxyURL = normalizeProxyURL(options.proxyURL);
  if (!proxyURL) return requestResultURL(url, target, options);
  const proxyRequest = typeof options.proxyRequest === 'function'
    ? options.proxyRequest
    : requestResultURLThroughProxy;
  return proxyRequest(url, target, proxyURL, options);
}

function requestResultURLThroughProxy(url, target, proxyURL, options) {
  const requestImpl = typeof options.proxyTransportRequest === 'function'
    ? options.proxyTransportRequest
    : https.request;
  const agent = new HttpsProxyAgent(proxyURL, { keepAlive: false });
  return executeResultRequest(requestImpl, [{
    protocol: 'https:',
    hostname: target.address,
    port: positiveInteger(url.port) || 443,
    method: 'GET',
    path: `${url.pathname}${url.search}`,
    headers: resultRequestHeaders({ Host: url.host }),
    servername: normalizeHostname(url.hostname),
    family: target.family,
    agent
  }], options);
}

function requestResultURL(url, target, options) {
  const requestImpl = typeof options.request === 'function' ? options.request : https.request;
  return executeResultRequest(requestImpl, [url, {
    method: 'GET',
    headers: resultRequestHeaders(),
    lookup: pinnedLookup(target),
    family: target.family,
    autoSelectFamily: false,
    servername: net.isIP(normalizeHostname(url.hostname)) ? undefined : normalizeHostname(url.hostname)
  }], options);
}

function executeResultRequest(requestImpl, requestArgs, options) {
  const timeoutMS = positiveInteger(options.timeoutMS) || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const signal = options.signal;
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', abortRequest);
      operation(value);
    };
    const rejectFetch = () => finish(reject, resultURLError(
      'image_url_fetch_failed',
      '图片结果地址下载失败，已禁止重放付费生图请求。'
    ));
    let request;
    const abortRequest = () => {
      if (request && typeof request.destroy === 'function') request.destroy(new Error('aborted'));
      rejectFetch();
    };
    try {
      request = requestImpl(...requestArgs, (response) => {
        const statusCode = Number(response && response.statusCode) || 0;
        if (statusCode >= 300 && statusCode < 400) {
          if (typeof response.resume === 'function') response.resume();
          const location = headerValue(response.headers, 'location');
          if (!location) {
            finish(reject, resultURLError('image_url_redirect_rejected', '图片结果地址返回了无效跳转。'));
            return;
          }
          finish(resolve, { redirect: location });
          return;
        }
        if (statusCode !== 200) {
          if (typeof response.resume === 'function') response.resume();
          finish(reject, resultURLError('image_url_http_error', `图片结果地址返回 HTTP ${statusCode || 'unknown'}。`));
          return;
        }
        finish(resolve, {
          stream: response,
          contentType: headerValue(response.headers, 'content-type'),
          contentLength: contentLength(response.headers)
        });
      });
    } catch {
      rejectFetch();
      return;
    }
    request.on('error', rejectFetch);
    request.setTimeout(timeoutMS, () => request.destroy(new Error('timeout')));
    if (signal) {
      if (signal.aborted) {
        abortRequest();
        return;
      }
      signal.addEventListener('abort', abortRequest, { once: true });
    }
    request.end();
  });
}

function resultRequestHeaders(extra = {}) {
  return {
    Accept: 'image/png,image/jpeg,image/webp',
    'User-Agent': 'gpteam-image-mcp/1',
    ...extra
  };
}

function normalizeProxyURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw resultURLError('image_url_proxy_invalid', '图片结果代理地址无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw resultURLError('image_url_proxy_invalid', '图片结果代理仅支持 HTTP 或 HTTPS。');
  }
  return parsed.href;
}

function pinnedLookup(target) {
  return (_hostname, _options, callback) => callback(null, target.address, target.family);
}

function readBoundedBody(stream, maxBytes, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', abortRead);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (typeof stream.destroy === 'function') stream.destroy();
      reject(error);
    };
    const abortRead = () => fail(resultURLError(
      'image_url_fetch_failed',
      '图片结果地址下载失败，已禁止重放付费生图请求。'
    ));
    if (signal) {
      if (signal.aborted) {
        abortRead();
        return;
      }
      signal.addEventListener('abort', abortRead, { once: true });
    }
    stream.on('data', (chunk) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        fail(tooLargeError(maxBytes));
        return;
      }
      chunks.push(bytes);
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    });
    stream.on('error', () => fail(resultURLError(
      'image_url_fetch_failed',
      '图片结果地址下载失败，已禁止重放付费生图请求。'
    )));
  });
}

function validateContentType(value) {
  const contentType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  if (!ACCEPTED_CONTENT_TYPES.has(contentType)) {
    throw resultURLError('image_url_content_type_invalid', '图片结果地址没有返回受支持的图片 Content-Type。');
  }
  return contentType === 'image/jpg' ? 'image/jpeg' : contentType;
}

function contentLength(headers) {
  const raw = headerValue(headers, 'content-length');
  if (!/^\d+$/.test(raw)) return 0;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : Number.MAX_SAFE_INTEGER;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const value = headers[name] ?? headers[String(name).toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '') : String(value || '');
}

function isPublicAddress(address, family) {
  if (family === 4) return isPublicIPv4(address);
  if (family === 6) return isPublicIPv6(address);
  return false;
}

function isPublicIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const value = octets.reduce((sum, part) => (sum * 256) + part, 0) >>> 0;
  return ![
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
  ].some(([base, prefix]) => inIPv4CIDR(value, base, prefix));
}

function inIPv4CIDR(value, base, prefix) {
  const baseValue = base.split('.').map(Number).reduce((sum, part) => (sum * 256) + part, 0) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isPublicIPv6(address) {
  const normalized = String(address || '').toLowerCase();
  const value = ipv6ToBigInt(normalized);
  if (value === null || !inIPv6CIDR(value, '2000::', 3)) return false;
  return ![
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20]
  ].some(([base, prefix]) => inIPv6CIDR(value, base, prefix));
}

function ipv6ToBigInt(address) {
  if (net.isIP(address) !== 6 || address.includes('.') || address.includes('%')) return null;
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts.reduce((result, part) => (result << 16n) + BigInt(`0x${part}`), 0n);
}

function inIPv6CIDR(value, base, prefix) {
  const baseValue = ipv6ToBigInt(base);
  if (baseValue === null) return false;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (baseValue >> shift);
}

function normalizeHostname(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function tooLargeError(maxBytes) {
  return resultURLError('image_url_too_large', `图片结果超过 ${maxBytes} 字节安全上限。`);
}

function forbiddenAddressError() {
  return resultURLError('image_url_forbidden', '图片结果地址不能指向本机、私有或保留网络。');
}

function resultURLError(code, message) {
  return new ImageMCPError(message, {
    code,
    category: 'response_invalid',
    stage: 'local',
    retryable: false
  });
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
