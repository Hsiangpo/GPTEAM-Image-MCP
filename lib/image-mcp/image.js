import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getProxyForUrl } from 'proxy-from-env';
import {
  ImageMCPError,
  imageErrorFromFetch,
  imageErrorFromHTTPResponse,
  redactSecret,
  serializeImageError
} from './errors.js';
import { DEFAULT_IMAGE_FORMAT, localImageToDataURL, normalizeImageFormat, writeImageOutput } from './files.js';
import { createProxyAwareFetch } from './proxy-fetch.js';
import { downloadImageResultURL } from './result-url.js';
import { validateFrozenCapability } from './validation.js';

export const DEFAULT_BASE_URL = 'https://api.gpteamservices.com';
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';
export { DEFAULT_IMAGE_FORMAT };

export const IMAGE_FORMATS = ['png', 'jpeg', 'webp'];
export const IMAGE_QUALITY_LEVELS = ['low', 'medium', 'high', 'auto'];
export const IMAGE_BACKGROUND_OPTIONS = ['auto', 'opaque'];
export const IMAGE_MODERATION_OPTIONS = ['auto', 'low'];
export const POPULAR_IMAGE_SIZES = [
  { label: '1K 方图', size: '1024x1024', aspect_ratio: '1:1' },
  { label: '2K 横图', size: '1536x1024', aspect_ratio: '3:2' },
  { label: '2K 竖图', size: '1024x1536', aspect_ratio: '2:3' },
  { label: '2K 方图', size: '2048x2048', aspect_ratio: '1:1' },
  { label: '2K 宽屏', size: '2048x1152', aspect_ratio: '16:9' },
  { label: '2K 竖幅', size: '1152x2048', aspect_ratio: '9:16' },
  { label: '4K 1:1', size: '2880x2880', aspect_ratio: '1:1' },
  { label: '4K 1:2', size: '1920x3840', aspect_ratio: '1:2' },
  { label: '4K 2:1', size: '3840x1920', aspect_ratio: '2:1' },
  { label: '4K 1:3', size: '1280x3840', aspect_ratio: '1:3' },
  { label: '4K 3:1', size: '3840x1280', aspect_ratio: '3:1' },
  { label: '4K 3:2', size: '3504x2336', aspect_ratio: '3:2' },
  { label: '4K 2:3', size: '2336x3504', aspect_ratio: '2:3' },
  { label: '4K 4:3', size: '3264x2448', aspect_ratio: '4:3' },
  { label: '4K 3:4', size: '2448x3264', aspect_ratio: '3:4' },
  { label: '4K 横图', size: '3840x2160', aspect_ratio: '16:9' },
  { label: '4K 竖图', size: '2160x3840', aspect_ratio: '9:16' },
  { label: '4K 21:9', size: '3840x1648', aspect_ratio: '21:9' },
  { label: '自动', size: 'auto', aspect_ratio: 'auto' }
];
export const IMAGE_SIZE_CONSTRAINTS = {
  max_edge_px: 3840,
  edge_multiple_px: 16,
  max_long_to_short_ratio: 3,
  min_total_pixels: 655360,
  max_total_pixels: 8294400
};

const defaultMaxAttempts = 3;
const defaultRetryDelayMs = 800;
const defaultRequestTimeoutMs = 15 * 60 * 1000;
const defaultMaxConcurrentJobs = 2;
const defaultMaxQueuedJobs = 20;
const defaultJobTTLMS = 30 * 60 * 1000;
const terminalStatuses = new Set(['succeeded', 'failed', 'canceled', 'expired']);

const defaultJobStore = createImageJobStore();

export function buildImageGenerationPayload(input = {}, options = {}) {
  if (options.normalizedRequest) return buildContractImagePayload(input, options.normalizedRequest, options);
  const payload = {
    model: String(input.model || DEFAULT_IMAGE_MODEL),
    prompt: String(input.prompt || '').trim(),
    response_format: 'b64_json',
    stream: true,
    size: String(input.size || '1024x1024'),
    quality: String(input.quality || 'high'),
    output_format: resolveImageOutputFormat(input)
  };
  const imageOptions = { ...options, home: options.home };
  const images = normalizeInputImages(collectInputImageValues(input), imageOptions);
  if (images.length > 0) payload.images = images.map((imageURL) => ({ image_url: imageURL }));
  const mask = normalizeImageReference(firstPresentImageReference(input.mask, input.mask_path), imageOptions);
  if (mask) payload.mask = { image_url: mask };
  copyOptionalImageToolOption(payload, input, 'background');
  copyOptionalImageToolOption(payload, input, 'moderation');
  copyOptionalImageToolOption(payload, input, 'output_compression');
  return payload;
}

function buildContractImagePayload(input, normalized, options) {
  const payload = { model: normalized.model };
  for (const [name, value] of Object.entries(normalized.forwarded_parameters || {})) {
    if (value === undefined || value === null) continue;
    if (name === 'images') {
      payload.images = normalizeInputImages(value, options).map((imageURL) => ({ image_url: imageURL }));
      continue;
    }
    if (name === 'mask') {
      const mask = normalizeImageReference(value, options);
      if (mask) payload.mask = { image_url: mask };
      continue;
    }
    payload[name] = value;
  }
  if (!payload.prompt) payload.prompt = String(input.prompt || '').trim();
  return payload;
}

export function loadGPTEAMCredentials(options = {}) {
  const env = options.env || process.env;
  const codexHome = resolveCodexHome(env, options.home || os.homedir());
  const readFile = options.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  const configText = safeRead(path.join(codexHome, 'config.toml'), readFile);
  const configuredBaseUrl = parseGPTEAMBaseUrl(configText);
  const apiKey = firstNonEmpty(env.GPTEAM_API_KEY);
  if (!apiKey) {
    throw new ImageMCPError('没有找到 GPTEAM API key。请在 MCP 配置 env 中设置 GPTEAM_API_KEY，或先运行 npx gpteam 完成本地配置。', {
      code: 'api_key_missing',
      category: 'configuration',
      stage: 'configuration',
      retryable: false
    });
  }
  const baseUrl = normalizeBaseUrl(firstNonEmpty(env.GPTEAM_BASE_URL, configuredBaseUrl, DEFAULT_BASE_URL));
  return { apiKey, baseUrl, codexHome };
}

export function parseGPTEAMBaseUrl(configText) {
  let inGPTEAMProvider = false;
  for (const rawLine of String(configText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      inGPTEAMProvider = table[1] === 'model_providers.gpteam';
      continue;
    }
    if (!inGPTEAMProvider) continue;
    const match = line.match(/^base_url\s*=\s*"((?:\\"|[^"])*)"/);
    if (match) return unescapeTomlString(match[1]);
  }
  return '';
}

export function normalizeBaseUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  if (/\/v1$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

export async function generateImage(input = {}, options = {}) {
  const startedAt = now(options);
  if (!options.normalizedRequest) validateImageInput(input, { requirePrompt: true });
  const credentials = loadGPTEAMCredentials(options);
  const payload = buildImageGenerationPayload(input, options);
  const fetchImpl = options.fetch || createProxyAwareFetch({ env: options.env });
  if (typeof fetchImpl !== 'function') {
    throw new ImageMCPError('当前 Node.js 运行时不支持 fetch，请升级到 Node.js 18.18 或更高版本。', {
      code: 'fetch_unavailable',
      category: 'environment',
      stage: 'configuration',
      retryable: false
    });
  }
  const jobID = String(input.job_id || options.jobID || makeID('img'));
  const traceID = String(input.trace_id || options.traceID || makeID('tr'));
  const requestOptions = options.normalizedRequest ? {
    ...options,
    action: options.normalizedRequest.action,
    maxAttempts: 1
  } : options;
  const result = await fetchImageWithRetry(fetchImpl, credentials, payload, requestOptions);
  const format = normalizeImageFormat(input.format || payload.output_format);
  const file = writeImageOutput({
    b64: result.b64,
    output_path: input.output_path,
    overwrite: input.overwrite,
    format
  }, options);
  const includeRevisedPrompt = resolveRevisedPromptFlag(input);
  const durationMs = now(options) - startedAt;
  return buildSuccessResult({
    jobID,
    traceID,
    payload,
    file,
    b64: result.b64,
    revisedPrompt: includeRevisedPrompt ? result.revisedPrompt : '',
    retryCount: result.retryCount,
    durationMs,
    idempotencyKey: normalizeIdempotencyKey(input.idempotency_key),
    action: options.normalizedRequest && options.normalizedRequest.action
  });
}

export function createImageJobStore(options = {}) {
  return {
    jobs: new Map(),
    queue: [],
    runningCount: 0,
    idempotency: new Map(),
    now: typeof options.now === 'function' ? options.now : Date.now,
    ttlMs: Number(options.ttlMs || defaultJobTTLMS),
    maxConcurrent: Number.isFinite(options.maxConcurrent) ? options.maxConcurrent : defaultMaxConcurrentJobs,
    maxQueue: Number.isFinite(options.maxQueue) ? options.maxQueue : defaultMaxQueuedJobs
  };
}

export function createImageJob(input = {}, options = {}) {
  try {
    if (!options.capabilitySnapshot) validateImageInput(input, { requirePrompt: true });
  } catch (error) {
    return resultFromError(error);
  }
  const store = options.store || defaultJobStore;
  configureJobStore(store, options);
  cleanupImageJobs(store);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotency_key);
  if (idempotencyKey) {
    const existingJobID = store.idempotency.get(idempotencyKey);
    const existingJob = existingJobID ? store.jobs.get(existingJobID) : null;
    if (existingJob) return publicJobStatus(existingJob);
    store.idempotency.delete(idempotencyKey);
  }
  if ((queuedJobCount(store) + store.runningCount) >= (store.maxConcurrent + store.maxQueue)) {
    return resultFromError(new ImageMCPError('图片任务队列已满，请稍后重试。', {
      code: 'queue_full',
      category: 'queue',
      stage: 'queue',
      retryable: true
    }));
  }
  const jobID = makeID('img');
  const traceID = makeID('tr');
  const controller = new AbortController();
  const job = {
    job_id: jobID,
    trace_id: traceID,
    idempotency_key: idempotencyKey,
    status: 'queued',
    ok: true,
    created_at: new Date(store.now()).toISOString(),
    updated_at: new Date(store.now()).toISOString(),
    expires_at: new Date(store.now() + store.ttlMs).toISOString(),
    controller,
    input: { ...input, idempotency_key: idempotencyKey },
    capability_snapshot: options.capabilitySnapshot ? cloneJSON(options.capabilitySnapshot) : null,
    options,
    result: null,
    error: null
  };
  store.jobs.set(jobID, job);
  if (idempotencyKey) store.idempotency.set(idempotencyKey, jobID);
  store.queue.push(jobID);
  queueMicrotask(() => scheduleImageJobs(store));
  return publicJobStatus(job);
}

export function getImageJobStatus(input = {}, options = {}) {
  const store = options.store || defaultJobStore;
  cleanupImageJobs(store);
  const job = store.jobs.get(String(input.job_id || ''));
  if (!job) return missingJobResult(input.job_id);
  return publicJobStatus(job);
}

export function cancelImageJob(input = {}, options = {}) {
  const store = options.store || defaultJobStore;
  const job = store.jobs.get(String(input.job_id || ''));
  if (!job) return missingJobResult(input.job_id);
  if (isTerminalStatus(job.status)) return publicJobStatus(job);
  job.controller.abort();
  job.status = 'canceled';
  job.ok = false;
  job.updated_at = new Date(store.now()).toISOString();
  job.error = {
    code: 'job_cancelled',
    message: '图片生成任务已取消。',
    retryable: false,
    stage: 'cancel',
    upstream_status: undefined,
    trace_id: job.trace_id,
    category: 'canceled'
  };
  return {
    ...publicJobStatus(job),
    ok: true,
    cancellation_mode: 'best_effort',
    cancellation_note: '已中止本地请求。若上游已经开始生成，无法保证上游也同步取消。'
  };
}

export function downloadImageResult(input = {}, options = {}) {
  const store = options.store || defaultJobStore;
  const job = store.jobs.get(String(input.job_id || ''));
  if (!job) return missingJobResult(input.job_id);
  if (job.status !== 'succeeded') return publicJobStatus(job);
  return shapeDownloadResult(job.result, input);
}

export function structuredToolResult(result) {
  if (!result || typeof result !== 'object') {
    return {
      ok: false,
      error: {
        code: 'empty_result',
        message: 'empty result',
        retryable: false,
        stage: 'unknown',
        upstream_status: undefined,
        trace_id: '',
        category: 'unknown'
      }
    };
  }
  const clone = { ...result };
  delete clone.b64;
  delete clone.mimeType;
  delete clone.revisedPrompt;
  delete clone.path;
  return clone;
}

export function toolResultContent(result) {
  const structured = structuredToolResult(result);
  const content = [{ type: 'text', text: JSON.stringify(structured, null, 2) }];
  if (result && result.ok && result.b64 && result.mimeType) {
    content.push({ type: 'image', data: result.b64, mimeType: result.mimeType });
  }
  return content;
}

export function resultFromError(error, meta = {}) {
  return {
    ok: false,
    job_id: meta.job_id || '',
    trace_id: meta.trace_id || '',
    status: 'failed',
    error: serializeImageError(error, meta)
  };
}

export function validateImageInput(input = {}, options = {}) {
  if (options.requirePrompt && !String(input.prompt || '').trim()) {
    throw imageParamError('prompt_required', 'prompt 不能为空', 'prompt', input.prompt, {
      hint: '请先让用户提供图片提示词。'
    });
  }
  validateImageSize(input.size);
  validateEnumImageParam('quality', input.quality, IMAGE_QUALITY_LEVELS);
  validateImageFormatParam(input);
  validateEnumImageParam('background', input.background, IMAGE_BACKGROUND_OPTIONS, {
    hint: 'gpt-image-2 不支持 transparent，请使用 auto 或 opaque。'
  });
  validateEnumImageParam('moderation', input.moderation, IMAGE_MODERATION_OPTIONS);
  validateOutputCompression(input.output_compression);
}

async function fetchImageWithRetry(fetchImpl, credentials, payload, options) {
  const maxAttempts = resolveBoundedInt(1, options.maxAttempts, options.env && options.env.GPTEAM_IMAGE_MAX_ATTEMPTS, defaultMaxAttempts);
  const retryDelayMs = resolveBoundedInt(0, options.retryDelayMs, options.env && options.env.GPTEAM_IMAGE_RETRY_DELAY_MS, defaultRetryDelayMs);
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImageOnce(fetchImpl, credentials, payload, options);
      return { ...response, retryCount: attempt - 1 };
    } catch (error) {
      const classified = error instanceof ImageMCPError ? error : imageErrorFromFetch(error, { apiKey: credentials.apiKey });
      lastError = classified;
      if (!classified.retryable || attempt >= maxAttempts) throw classified;
      await delay(retryDelayMs * Math.max(1, attempt), options);
    }
  }
  throw lastError;
}

async function fetchImageOnce(fetchImpl, credentials, payload, options) {
  const requestSignal = createRequestSignal(options);
	const endpoint = imageEndpointFromRequest(payload, options.action, options.normalizedRequest);
	const requestURL = imageRequestURL(credentials.baseUrl, endpoint);
  try {
	const response = await fetchImpl(requestURL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: requestSignal.signal
    });
    if (!response.ok) throw await imageErrorFromHTTPResponse(response, credentials.apiKey);
    const resultOptions = { ...options, resultURLSignal: requestSignal.signal };
    if (isEventStreamResponse(response)) return await readImageSSE(response, resultOptions);
    return await readImageJSON(response, resultOptions);
  } catch (error) {
    if (error instanceof ImageMCPError) throw error;
    throw imageErrorFromFetch(error, {
      apiKey: credentials.apiKey,
      timedOut: requestSignal.timedOut(),
      cancelled: Boolean(options.signal && options.signal.aborted)
    });
  } finally {
    requestSignal.clear();
  }
}

async function readImageJSON(response, options) {
  const data = await response.json();
  const first = Array.isArray(data && data.data) ? data.data[0] : null;
  return imageResultFromItem(first, options);
}

async function readImageSSE(response, options) {
  const text = await response.text();
  let lastError = null;
  for (const event of parseSSEDataEvents(text)) {
    if (!event || event === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(event);
    } catch {
      continue;
    }
    if (payload && payload.error) {
      lastError = imageErrorFromSSEPayload(payload);
      continue;
    }
    const item = await imageResultFromStreamPayload(payload, options);
    if (item) return item;
  }
  if (lastError) throw lastError;
  throw missingImageDataError();
}

function parseSSEDataEvents(text) {
  const events = [];
  let current = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (rawLine === '') {
      if (current.length > 0) events.push(current.join('\n'));
      current = [];
      continue;
    }
    if (rawLine.startsWith('data:')) current.push(rawLine.slice(5).trimStart());
  }
  if (current.length > 0) events.push(current.join('\n'));
  return events;
}

function imageResultFromStreamPayload(payload, options) {
  const type = String(payload && payload.type || '');
  if (!type.endsWith('.completed')) return null;
  return imageResultFromItem(payload, options);
}

async function imageResultFromItem(first, options = {}) {
  const b64 = first && typeof first.b64_json === 'string' ? first.b64_json : imageDataURLToB64(first && first.url);
  const resultURL = first && typeof first.url === 'string' ? first.url.trim() : '';
  const downloaded = !b64 && resultURL ? await downloadImageResultURL(resultURL, {
    lookup: options.resultURLLookup,
    request: options.resultURLRequest,
    proxyURL: resolveResultURLProxy(resultURL, options),
    proxyRequest: options.resultURLProxyRequest,
    proxyTransportRequest: options.resultURLProxyTransportRequest,
    maxBytes: options.resultURLMaxBytes,
    maxRedirects: options.resultURLMaxRedirects,
    timeoutMS: options.resultURLTimeoutMS,
    signal: options.resultURLSignal
  }) : '';
  if (!b64 && !downloaded) throw missingImageDataError();
  return {
    b64: b64 || downloaded,
    revisedPrompt: first && typeof first.revised_prompt === 'string' ? first.revised_prompt : ''
  };
}

function resolveResultURLProxy(resultURL, options) {
  if (Object.prototype.hasOwnProperty.call(options, 'resultURLProxyURL')) {
    return String(options.resultURLProxyURL || '').trim();
  }
  const explicit = String(options.env?.GPTEAM_IMAGE_RESULT_PROXY_URL || '').trim();
  return explicit || String(getProxyForUrl(resultURL) || '').trim();
}

function imageDataURLToB64(value) {
  const text = String(value || '').trim();
  const match = text.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
  return match ? match[1] : '';
}

function missingImageDataError() {
  return new ImageMCPError('GPTEAM 图片接口没有返回 b64_json 图片数据。', {
    code: 'image_data_missing',
    category: 'response_invalid',
    stage: 'local',
    retryable: false
  });
}

function imageErrorFromSSEPayload(payload) {
  const error = payload && payload.error;
  const message = typeof error === 'string' ? error : String(error && error.message || 'GPTEAM 图片流返回错误。');
  const code = typeof error === 'object' && error ? String(error.code || payload.code || 'upstream_stream_error') : String(payload.code || 'upstream_stream_error');
  return new ImageMCPError(message, {
    code,
    category: 'upstream',
    stage: 'upstream',
    retryable: code === 'rate_limit_exceeded' || code === 'server_error'
  });
}

function isEventStreamResponse(response) {
  const contentType = response && response.headers && typeof response.headers.get === 'function'
    ? String(response.headers.get('content-type') || '')
    : '';
  return /text\/event-stream/i.test(contentType);
}

function buildSuccessResult(input) {
  const result = {
    ok: true,
    status: 'succeeded',
    file: input.file.file,
    final_file: input.file.final_file,
    path: input.file.file,
    model: input.payload.model,
    action: input.action || imageActionFromPayload(input.payload),
    size: input.payload.size,
    format: input.file.format,
    output_format: input.file.format,
    quality: input.payload.quality,
    mime_type: input.file.mime_type,
    mimeType: input.file.mime_type,
    bytes: input.file.bytes,
    sha256: input.file.sha256,
    width: input.file.width,
    height: input.file.height,
    duration_ms: input.durationMs,
    retry_count: input.retryCount,
    job_id: input.jobID,
    trace_id: input.traceID,
    idempotency_key: input.idempotencyKey || undefined,
    b64: input.b64
  };
  if (input.revisedPrompt) {
    result.revised_prompt = input.revisedPrompt;
    result.revisedPrompt = input.revisedPrompt;
  }
  return result;
}

function scheduleImageJobs(store) {
  cleanupImageJobs(store);
  while (store.runningCount < store.maxConcurrent && store.queue.length > 0) {
    const jobID = store.queue.shift();
    const job = store.jobs.get(jobID);
    if (!job || job.status !== 'queued') continue;
    store.runningCount += 1;
    queueMicrotask(() => runImageJob(store, job));
  }
}

async function runImageJob(store, job) {
  if (job.status === 'canceled') {
    store.runningCount = Math.max(0, store.runningCount - 1);
    scheduleImageJobs(store);
    return;
  }
  job.status = 'running';
  job.updated_at = new Date(store.now()).toISOString();
  try {
    if (job.capability_snapshot) await revalidateQueuedJob(job);
    const result = await generateImage({ ...job.input, job_id: job.job_id, trace_id: job.trace_id }, {
      ...job.options,
      signal: job.controller.signal,
      normalizedRequest: job.capability_snapshot || undefined,
      maxAttempts: job.capability_snapshot ? 1 : job.options.maxAttempts
    });
    if (job.status === 'canceled') return;
    job.status = 'succeeded';
    job.ok = true;
    job.result = result;
  } catch (error) {
    if (job.status !== 'canceled') {
      job.status = 'failed';
      job.ok = false;
      job.error = serializeImageError(error, { trace_id: job.trace_id });
    }
  } finally {
    job.updated_at = new Date(store.now()).toISOString();
    store.runningCount = Math.max(0, store.runningCount - 1);
    scheduleImageJobs(store);
  }
}

async function revalidateQueuedJob(job) {
  if (typeof job.options.revalidateCapabilities !== 'function') {
    throw new ImageMCPError('图片能力无法在派发前重新验证，任务未发送到上游。', {
      code: 'stale_capability', category: 'capability', stage: 'capability', retryable: false
    });
  }
  try {
    const fresh = await job.options.revalidateCapabilities();
    validateFrozenCapability(job.capability_snapshot, fresh);
  } catch (error) {
    if (error instanceof ImageMCPError && error.code === 'stale_capability') throw error;
    throw new ImageMCPError('图片能力在任务排队期间失效或无法刷新，任务未发送到上游。', {
      code: 'stale_capability', category: 'capability', stage: 'capability', retryable: false,
      details: { reason: error && error.code ? String(error.code) : 'refresh_failed' }
    });
  }
}

function publicJobStatus(job) {
  const base = {
    ok: job.status !== 'failed' && job.status !== 'canceled' && job.status !== 'expired',
    job_id: job.job_id,
    trace_id: job.trace_id,
    idempotency_key: job.idempotency_key || undefined,
    status: job.status,
    legacy_status: job.status === 'canceled' ? 'cancelled' : undefined,
    created_at: job.created_at,
    updated_at: job.updated_at,
    expires_at: job.expires_at,
    model: job.capability_snapshot && job.capability_snapshot.model || undefined,
    action: job.capability_snapshot && job.capability_snapshot.action || undefined,
    capability_revision: job.capability_snapshot && job.capability_snapshot.revision || undefined
  };
  if (job.result) return { ...base, ...structuredToolResult(job.result) };
  if (job.error) return { ...base, error: job.error };
  return base;
}

function missingJobResult(jobID) {
  return {
    ok: false,
    job_id: String(jobID || ''),
    status: 'not_found',
    error: {
      code: 'job_not_found',
      message: '没有找到这个图片任务。',
      retryable: false,
      stage: 'lookup',
      upstream_status: undefined,
      trace_id: '',
      category: 'not_found'
    }
  };
}

function cleanupImageJobs(store) {
  const threshold = store.now() - store.ttlMs;
  for (const [jobID, job] of store.jobs.entries()) {
    const created = Date.parse(job.created_at || '');
    if (job.status === 'queued' && Number.isFinite(created) && created < threshold) {
      job.status = 'expired';
      job.ok = false;
      job.updated_at = new Date(store.now()).toISOString();
      job.error = {
        code: 'job_expired',
        message: '图片任务已过期，请重新创建任务。',
        retryable: false,
        stage: 'queue',
        upstream_status: undefined,
        trace_id: job.trace_id,
        category: 'queue'
      };
    }
    if (job.status === 'queued' || job.status === 'running') continue;
    const updated = Date.parse(job.updated_at || job.created_at || '');
    if (Number.isFinite(updated) && updated < threshold) removeImageJob(store, jobID, job);
  }
  store.queue = store.queue.filter((jobID) => {
    const job = store.jobs.get(jobID);
    return job && job.status === 'queued';
  });
}

function configureJobStore(store, options = {}) {
  const env = options.env || process.env;
  store.maxConcurrent = resolveBoundedInt(1, options.maxConcurrent, env.GPTEAM_IMAGE_MAX_CONCURRENT, store.maxConcurrent || defaultMaxConcurrentJobs);
  store.maxQueue = resolveBoundedInt(0, options.maxQueue, env.GPTEAM_IMAGE_MAX_QUEUE, store.maxQueue || defaultMaxQueuedJobs);
}

function queuedJobCount(store) {
  return store.queue.filter((jobID) => {
    const job = store.jobs.get(jobID);
    return job && job.status === 'queued';
  }).length;
}

function removeImageJob(store, jobID, job) {
  store.jobs.delete(jobID);
  if (job && job.idempotency_key && store.idempotency.get(job.idempotency_key) === jobID) {
    store.idempotency.delete(job.idempotency_key);
  }
}

function isTerminalStatus(status) {
  return terminalStatuses.has(String(status || ''));
}

function normalizeIdempotencyKey(value) {
  return String(value || '').trim().slice(0, 200);
}

function shapeDownloadResult(result, input = {}) {
  const includeImage = input.include_image === true && !input.metadata_only;
  const includeRevisedPrompt = input.include_revised_prompt !== false;
  const output = {
    ...result,
    status: 'succeeded'
  };
  if (!includeImage) {
    delete output.b64;
    delete output.mimeType;
  }
  if (!includeRevisedPrompt) {
    delete output.revised_prompt;
    delete output.revisedPrompt;
  }
  return output;
}

function imageEndpointFromRequest(payload, action, normalizedRequest) {
  const resolvedAction = action || imageActionFromPayload(payload);
  const expected = resolvedAction === 'edit'
    ? '/v1/gpteam/image-mcp/images/edits'
    : '/v1/gpteam/image-mcp/images/generations';
  if (normalizedRequest && normalizedRequest.endpoint !== expected) {
    throw new ImageMCPError('图片能力合同包含非 MCP 专用执行端点。', {
      code: 'capability_response_invalid', category: 'capability', stage: 'capability', retryable: false
    });
  }
  return expected;
}

function imageRequestURL(baseURL, endpoint) {
	if (endpoint.startsWith('/v1/')) return new URL(endpoint, new URL(baseURL).origin).toString();
	return `${String(baseURL).replace(/\/+$/, '')}${endpoint}`;
}

function imageActionFromPayload(payload) {
  return Array.isArray(payload.images) && payload.images.length > 0 ? 'edit' : 'generate';
}

function normalizeInputImages(value, options = {}) {
  const rawImages = Array.isArray(value) ? value : (value ? [value] : []);
  return rawImages.map((item) => normalizeImageReference(item, options)).filter(Boolean);
}

function collectInputImageValues(input = {}) {
  const values = [];
  appendImageAlias(values, input.images);
  appendImageAlias(values, input.image);
  appendImageAlias(values, input.image_path);
  appendImageAlias(values, input.image_paths);
  appendImageAlias(values, input.input_image);
  appendImageAlias(values, input.input_images);
  return values;
}

function appendImageAlias(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) appendImageAlias(target, item);
    return;
  }
  if (value) target.push(value);
}

function firstPresentImageReference(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      if (value.length > 0) return value[0];
      continue;
    }
    if (value) return value;
  }
  return '';
}

function normalizeImageReference(value, options = {}) {
  if (!value) return '';
  if (typeof value === 'object') {
    return normalizeImageReference(value.image_url || value.url || value.path || value.file, options);
  }
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(text)) return text;
  if (/^https?:\/\//i.test(text)) return text;
  try {
    return localImageToDataURL(text, options);
  } catch (error) {
    throw new ImageMCPError(`读取输入图片失败：${error.message}`, {
      code: 'input_image_read_failed',
      category: 'file_system',
      stage: 'local',
      retryable: false
    });
  }
}

function copyOptionalImageToolOption(payload, input, key) {
  if (!Object.prototype.hasOwnProperty.call(input, key)) return;
  const value = input[key];
  if (value === undefined || value === null || value === '') return;
  payload[key] = value;
}

function createRequestSignal(options = {}) {
  const timeoutMs = resolveBoundedInt(1, options.requestTimeoutMs, options.env && options.env.GPTEAM_IMAGE_REQUEST_TIMEOUT_MS, defaultRequestTimeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const parent = options.signal;
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', () => {
      clearTimeout(timer);
      controller.abort();
    }, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    clear: () => clearTimeout(timer)
  };
}

function resolveRevisedPromptFlag(input) {
  if (Object.prototype.hasOwnProperty.call(input, 'include_revised_prompt')) return Boolean(input.include_revised_prompt);
  if (Object.prototype.hasOwnProperty.call(input, 'return_revised_prompt')) return Boolean(input.return_revised_prompt);
  return true;
}

function validateImageSize(value) {
  if (value === undefined || value === null || value === '') return;
  const text = String(value).trim().toLowerCase();
  if (text === 'auto') return;
  const match = text.match(/^(\d{2,5})x(\d{2,5})$/);
  if (!match) {
    throw imageParamError('invalid_size', 'size 必须是 auto 或类似 1024x1024 的宽高格式。', 'size', value, {
      supported_values: POPULAR_IMAGE_SIZES.map((item) => item.size),
      hint: '常用：2880x2880、1920x3840、3840x1920、1280x3840、3840x1280、3504x2336、2336x3504、3264x2448、2448x3264、3840x2160、2160x3840、3840x1648。'
    });
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const longSide = Math.max(width, height);
  const shortSide = Math.min(width, height);
  const pixels = width * height;
  const valid = width % IMAGE_SIZE_CONSTRAINTS.edge_multiple_px === 0 &&
    height % IMAGE_SIZE_CONSTRAINTS.edge_multiple_px === 0 &&
    longSide <= IMAGE_SIZE_CONSTRAINTS.max_edge_px &&
    longSide / shortSide <= IMAGE_SIZE_CONSTRAINTS.max_long_to_short_ratio &&
    pixels >= IMAGE_SIZE_CONSTRAINTS.min_total_pixels &&
    pixels <= IMAGE_SIZE_CONSTRAINTS.max_total_pixels;
  if (!valid) {
    throw imageParamError('invalid_size', 'size 超出 gpt-image-2 支持范围。', 'size', value, {
      constraints: IMAGE_SIZE_CONSTRAINTS,
      supported_values: POPULAR_IMAGE_SIZES.map((item) => item.size),
      hint: '宽高需为 16 的倍数，长边不超过 3840，长短边比例不超过 3:1；1:8、1:9 这类超长比例不稳定，当前不作为支持尺寸。'
    });
  }
}

function validateEnumImageParam(field, value, supportedValues, extra = {}) {
  if (value === undefined || value === null || value === '') return;
  const normalized = String(value).trim().toLowerCase();
  if (supportedValues.includes(normalized)) return;
  throw imageParamError(`invalid_${field}`, `${field} 参数不支持。`, field, value, {
    supported_values: supportedValues,
    ...extra
  });
}

function validateImageFormatParam(input) {
  const formatValue = input.format;
  const outputFormatValue = input.output_format;
  const format = normalizeDeclaredImageFormat(formatValue);
  const outputFormat = normalizeDeclaredImageFormat(outputFormatValue);
  if (formatValue !== undefined && formatValue !== null && formatValue !== '' && !IMAGE_FORMATS.includes(format)) {
    throw invalidImageFormatError('format', formatValue);
  }
  if (outputFormatValue !== undefined && outputFormatValue !== null && outputFormatValue !== '' && !IMAGE_FORMATS.includes(outputFormat)) {
    throw invalidImageFormatError('output_format', outputFormatValue);
  }
  if (format && outputFormat && format !== outputFormat) {
    throw imageParamError('invalid_format_conflict', 'format 和 output_format 不一致。', 'output_format', outputFormatValue, {
      format,
      output_format: outputFormat,
      hint: '两个字段同时传入时必须表示同一种格式，例如 jpg 和 jpeg 可以同时使用。'
    });
  }
}

function validateOutputCompression(value) {
  if (value === undefined || value === null || value === '') return;
  const amount = Number(value);
  if (Number.isInteger(amount) && amount >= 0 && amount <= 100) return;
  throw imageParamError('invalid_output_compression', 'output_compression 必须是 0 到 100 的整数。', 'output_compression', value, {
    supported_values: ['0-100']
  });
}

function resolveImageOutputFormat(input = {}) {
  return normalizeImageFormat(input.output_format || input.format || DEFAULT_IMAGE_FORMAT);
}

function normalizeDeclaredImageFormat(value) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'jpg' ? 'jpeg' : normalized;
}

function invalidImageFormatError(field, received) {
  return imageParamError('invalid_format', 'format/output_format 参数不支持。', field, received, {
    supported_values: IMAGE_FORMATS,
    hint: '支持 png、jpeg、webp，jpg 会按 jpeg 处理。'
  });
}

function imageParamError(code, message, field, received, details = {}) {
  return new ImageMCPError(message, {
    code,
    category: 'parameter',
    stage: 'validate',
    retryable: false,
    details: {
      field,
      received,
      ...details
    }
  });
}

function resolveCodexHome(env, home) {
  return expandHome(firstNonEmpty(env.GPTEAM_CODEX_HOME, env.CODEX_HOME, path.join(home, '.codex')), home);
}

function safeRead(filePath, readFile) {
  try {
    return readFile(filePath);
  } catch {
    return '';
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function expandHome(value, home) {
  const text = String(value || '');
  if (text === '~') return home;
  if (text.startsWith(`~${path.sep}`)) return path.join(home, text.slice(2));
  if (text.startsWith('~/')) return path.join(home, text.slice(2));
  return text;
}

function unescapeTomlString(value) {
  return String(value || '').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function makeID(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function now(options = {}) {
  return typeof options.now === 'function' ? options.now() : Date.now();
}

function resolveBoundedInt(min, ...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = Number.parseInt(String(value), 10);
    if (Number.isFinite(parsed) && parsed >= min) return parsed;
  }
  return min;
}

async function delay(ms, options = {}) {
  if (ms <= 0) return;
  if (typeof options.sleep === 'function') return options.sleep(ms);
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function redactImageSecret(text, secret) {
  return redactSecret(text, secret);
}

function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}
