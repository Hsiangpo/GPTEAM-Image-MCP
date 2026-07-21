import { ProxyAgent } from 'undici';
import { ImageMCPError } from './errors.js';

const DEFAULT_PORTS = { http: 80, https: 443 };
const DEFAULT_MAX_DISPATCHERS = 8;
const sharedDispatchers = new Map();

export function createProxyAwareFetch(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return undefined;
  const env = options.env || process.env;
  const createDispatcher = options.createDispatcher || createProxyDispatcher;
  const dispatchers = options.dispatcherCache || (options.createDispatcher ? new Map() : sharedDispatchers);
  const maxDispatchers = positiveDispatcherLimit(options.maxDispatchers);

  return async (url, init = {}) => {
    if (init.dispatcher) return fetchImpl(url, init);
    const proxyURL = proxyURLFor(url, env);
    if (!proxyURL) return fetchImpl(url, init);
    const dispatcher = resolveDispatcher(dispatchers, proxyURL, createDispatcher, maxDispatchers);
    return fetchImpl(url, { ...init, dispatcher });
  };
}

function resolveDispatcher(dispatchers, proxyURL, createDispatcher, maxDispatchers) {
  const cached = dispatchers.get(proxyURL);
  if (cached) {
    dispatchers.delete(proxyURL);
    dispatchers.set(proxyURL, cached);
    return cached;
  }
  while (dispatchers.size >= maxDispatchers) {
    const oldestKey = dispatchers.keys().next().value;
    closeDispatcher(dispatchers.get(oldestKey));
    dispatchers.delete(oldestKey);
  }
  const dispatcher = createDispatcher(proxyURL);
  dispatchers.set(proxyURL, dispatcher);
  return dispatcher;
}

function closeDispatcher(dispatcher) {
  if (!dispatcher || typeof dispatcher.close !== 'function') return;
  try {
    const closing = dispatcher.close();
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch {
    // 淘汰缓存时关闭失败不能覆盖下一次代理请求。
  }
}

function positiveDispatcherLimit(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 32) : DEFAULT_MAX_DISPATCHERS;
}

function createProxyDispatcher(proxyURL) {
  let parsed;
  try {
    parsed = new URL(proxyURL);
  } catch {
    throw proxyConfigurationError('代理地址无效，请使用完整的 HTTP 或 HTTPS URL。', 'proxy_url_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw proxyConfigurationError('Image MCP 代理仅支持 HTTP 或 HTTPS 协议。', 'proxy_protocol_unsupported');
  }
  return new ProxyAgent(parsed);
}

function proxyConfigurationError(message, code) {
  return new ImageMCPError(message, {
    code,
    category: 'configuration',
    stage: 'configuration',
    retryable: false
  });
}

export function proxyURLFor(value, env = process.env) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return '';
  }
  const protocol = url.protocol.replace(/:$/, '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_PORTS, protocol) || !url.hostname) return '';
  const port = Number(url.port) || DEFAULT_PORTS[protocol];
  if (bypassesProxy(url.hostname, port, envValue(env, 'npm_config_no_proxy') || envValue(env, 'no_proxy'))) {
    return '';
  }
  let proxy = envValue(env, `npm_config_${protocol}_proxy`) ||
    envValue(env, `${protocol}_proxy`) ||
    envValue(env, 'npm_config_proxy') ||
    envValue(env, 'all_proxy');
  if (!proxy) return '';
  if (!proxy.includes('://')) proxy = `${protocol}://${proxy}`;
  return proxy;
}

function bypassesProxy(hostnameValue, port, noProxyValue) {
  const noProxy = String(noProxyValue || '').trim().toLowerCase();
  if (!noProxy) return false;
  if (noProxy === '*') return true;
  const hostname = String(hostnameValue || '').toLowerCase();
  return noProxy.split(/[,\s]+/).some((entry) => proxyEntryMatches(entry, hostname, port));
}

function proxyEntryMatches(entryValue, hostname, port) {
  const entry = String(entryValue || '').trim();
  if (!entry) return false;
  const parsed = entry.match(/^(.+):(\d+)$/);
  const entryHostname = parsed ? parsed[1] : entry;
  const entryPort = parsed ? Number(parsed[2]) : 0;
  if (entryPort && entryPort !== port) return false;
  if (entryHostname.startsWith('*')) return hostname.endsWith(entryHostname.slice(1));
  if (entryHostname.startsWith('.')) return hostname.endsWith(entryHostname);
  return hostname === entryHostname;
}

function envValue(env, key) {
  return String(env && (env[key.toLowerCase()] || env[key.toUpperCase()]) || '').trim();
}
