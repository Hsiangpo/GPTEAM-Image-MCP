import { formatNetworkError } from '../errors.js';

export class ImageMCPError extends Error {
  constructor(message, options = {}) {
    super(String(message || 'GPTEAM image MCP error'));
    this.name = 'ImageMCPError';
    this.code = String(options.code || 'image_mcp_error');
    this.category = String(options.category || 'unknown');
    this.stage = String(options.stage || stageFromCategory(this.category));
    this.retryable = Boolean(options.retryable);
    this.http_status = Number.isFinite(options.http_status) ? options.http_status : undefined;
    this.upstream_status = Number.isFinite(options.upstream_status) ? options.upstream_status : this.http_status;
    this.details = options.details || undefined;
  }
}

export async function imageErrorFromHTTPResponse(response, apiKey) {
  const status = Number(response && response.status) || 0;
  const rawText = typeof response.text === 'function' ? await response.text() : '';
  const detail = parseUpstreamError(rawText);
  const upstreamCode = String(detail.code || detail.type || '').trim();
  const bodyMessage = detail.message || rawText || '';
  const message = redactSecret(bodyMessage ? `HTTP ${status}: ${bodyMessage}` : `HTTP ${status}`, apiKey);
  if (status === 429) {
    return new ImageMCPError(message, {
      code: upstreamCode || 'rate_limit_exceeded',
      category: 'upstream_rate_limit',
      stage: 'upstream',
      http_status: status,
      retryable: true
    });
  }
  if (status >= 500 || status === 408) {
    return new ImageMCPError(message, {
      code: upstreamCode || 'upstream_server_error',
      category: status === 408 ? 'timeout' : 'upstream_server',
      stage: 'upstream',
      http_status: status,
      retryable: true
    });
  }
  if (isContentSafetyError(upstreamCode, message)) {
    return new ImageMCPError(message, {
      code: upstreamCode || 'content_safety_rejected',
      category: 'content_safety',
      stage: 'upstream',
      http_status: status,
      retryable: false
    });
  }
  return new ImageMCPError(message, {
    code: upstreamCode || (status === 401 || status === 403 ? 'authentication_failed' : 'invalid_request_error'),
    category: status === 401 || status === 403 ? 'authentication' : 'parameter',
    stage: status === 401 || status === 403 ? 'upstream' : 'validate',
    http_status: status,
    retryable: false
  });
}

export function imageErrorFromFetch(error, options = {}) {
  if (options.cancelled) {
    return new ImageMCPError('图片生成任务已取消。', {
      code: 'job_cancelled',
      category: 'canceled',
      stage: 'cancel',
      retryable: false
    });
  }
  const message = redactSecret(formatNetworkError(error), options.apiKey);
  const timeoutLike = options.timedOut || /timeout|timedout|etimedout/i.test(message);
  return new ImageMCPError(message, {
    code: timeoutLike ? 'network_timeout' : 'network_error',
    category: timeoutLike ? 'timeout' : 'network',
    stage: 'network',
    retryable: true
  });
}

export function serializeImageError(error, meta = {}) {
  if (error instanceof ImageMCPError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      stage: error.stage,
      upstream_status: error.upstream_status,
      trace_id: meta.trace_id || '',
      category: error.category,
      http_status: error.http_status,
      details: error.details
    };
  }
  return {
    code: 'image_mcp_error',
    message: error && error.message ? String(error.message) : String(error || 'unknown error'),
    retryable: false,
    stage: 'unknown',
    upstream_status: undefined,
    trace_id: meta.trace_id || '',
    category: 'unknown'
  };
}

export function redactSecret(text, secret) {
  let result = String(text || '');
  if (secret) result = result.split(secret).join('[redacted]');
  result = result.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]');
  return result;
}

function parseUpstreamError(text) {
  try {
    const parsed = JSON.parse(String(text || ''));
    const error = parsed && typeof parsed === 'object' ? parsed.error : null;
    if (error && typeof error === 'object') {
      return {
        code: error.code,
        type: error.type,
        message: error.message
      };
    }
  } catch {
    return {};
  }
  return {};
}

function isContentSafetyError(code, message) {
  const text = `${code || ''} ${message || ''}`.toLowerCase();
  return /content|safety|policy|moderation/.test(text);
}

function stageFromCategory(category) {
  switch (String(category || '').toLowerCase()) {
  case 'parameter':
    return 'validate';
  case 'configuration':
  case 'environment':
    return 'configuration';
  case 'file_system':
  case 'response_invalid':
    return 'local';
  case 'authentication':
  case 'content_safety':
  case 'upstream_rate_limit':
  case 'upstream_server':
    return 'upstream';
  case 'timeout':
  case 'network':
    return 'network';
  case 'canceled':
  case 'cancelled':
    return 'cancel';
  case 'not_found':
    return 'lookup';
  case 'queue':
    return 'queue';
  default:
    return 'unknown';
  }
}
