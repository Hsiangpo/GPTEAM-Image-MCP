import crypto from 'node:crypto';
import { ImageMCPError, redactSecret } from './errors.js';
import { createProxyAwareFetch } from './proxy-fetch.js';

const SCHEMA_VERSION = 1;
const MAX_CACHE_AGE_MS = 60_000;
const REQUIRED_TOOLS = [
  'create_image_job',
  'get_image_job_status',
  'download_image_result',
  'cancel_image_job',
  'get_capabilities'
];
const defaultCache = createCapabilityCache();

export function createCapabilityCache(options = {}) {
  return {
    entries: new Map(),
    inflight: new Map(),
    now: typeof options.now === 'function' ? options.now : Date.now,
    maxAgeMS: Math.min(MAX_CACHE_AGE_MS, positiveInteger(options.maxAgeMS) || MAX_CACHE_AGE_MS),
    hmacKey: normalizeHMACKey(options.hmacKey)
  };
}

export function capabilityCacheIdentity(credentials, hmacKey) {
  const origin = capabilityOrigin(credentials && credentials.baseUrl);
  const key = normalizeHMACKey(hmacKey);
  return crypto.createHmac('sha256', key)
    .update(`${origin}\0${String(credentials && credentials.apiKey || '')}`)
    .digest('hex');
}

export async function fetchImageCapabilities(credentials, options = {}) {
  assertCredentials(credentials);
  const cache = options.cache || defaultCache;
  const identity = capabilityCacheIdentity(credentials, cache.hmacKey);
  const cached = cache.entries.get(identity);
  const ageMS = cached ? Math.max(0, cache.now() - cached.fetchedAt) : Number.POSITIVE_INFINITY;
  if (!options.forceRefresh && cached && ageMS <= cache.maxAgeMS) {
    return cloneCapability({ ...cached.capability, cache_age_ms: ageMS });
  }
  const active = cache.inflight.get(identity);
  if (!active) {
    return startCapabilityRefresh(credentials, cache, identity, options, options.forceRefresh === true);
  }
  if (!options.forceRefresh || active.forceRefresh) return active.promise;
  if (!active.forcedFollowup) {
    active.forcedFollowup = active.promise.then(
      () => startCapabilityRefresh(credentials, cache, identity, options, true),
      () => startCapabilityRefresh(credentials, cache, identity, options, true)
    );
  }
  return active.forcedFollowup;
}

function startCapabilityRefresh(credentials, cache, identity, options, forceRefresh) {
  const cached = cache.entries.get(identity);
  const active = { forceRefresh, promise: undefined, forcedFollowup: undefined };
  const operation = refreshCapabilities(credentials, cached, options)
    .then((result) => {
      cache.entries.set(identity, {
        capability: cloneCapability(result.capability),
        etag: result.etag,
        fetchedAt: cache.now()
      });
      return cloneCapability({ ...result.capability, cache_age_ms: 0 });
    })
    .finally(() => {
      if (cache.inflight.get(identity) === active) cache.inflight.delete(identity);
    });
  active.promise = operation;
  cache.inflight.set(identity, active);
  return operation;
}

async function refreshCapabilities(credentials, cached, options) {
  const fetchImpl = options.fetch || createProxyAwareFetch({ env: options.env });
  if (typeof fetchImpl !== 'function') {
    throw capabilityError('capability_fetch_failed', '当前 Node.js 运行时不支持能力查询。', true);
  }
  const headers = {
    Authorization: `Bearer ${credentials.apiKey}`,
    Accept: 'application/json',
    'User-Agent': 'gpteam-image-mcp/1'
  };
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;
  let response;
  try {
    response = await fetchImpl(capabilityURL(credentials.baseUrl), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: timeoutSignal(options.timeoutMS)
    });
  } catch (error) {
    if (error instanceof ImageMCPError && error.category === 'configuration' && error.retryable === false) {
      throw error;
    }
    throw capabilityError(
      'capability_fetch_failed',
      `图片能力查询失败：${redactSecret(error && error.message ? error.message : error, credentials.apiKey)}`,
      true
    );
  }
  const status = Number(response && response.status) || 0;
  if (status >= 300 && status < 400 && status !== 304) {
    throw capabilityError('capability_redirect_rejected', '图片能力查询拒绝跨地址重定向。');
  }
  if (status === 304) {
    if (!cached || !cached.capability || !etagMatches(response, cached.etag)) {
      throw capabilityError('capability_response_invalid', '图片能力缓存校验失败。');
    }
    return { capability: cached.capability, etag: cached.etag };
  }
  if (status === 401) throw capabilityError('capability_authentication_failed', 'GPTEAM API Key 未通过认证。');
  if (status === 403) throw capabilityError('capability_permission_denied', '当前 GPTEAM API Key 没有可用图片能力。');
  if (status === 404 || status === 405) {
    throw capabilityError('capability_endpoint_unavailable', '当前入口未提供 schema-v1 图片能力接口。');
  }
  if (!response || !response.ok) {
    throw capabilityError('capability_fetch_failed', `图片能力查询返回 HTTP ${status || 'unknown'}。`, status >= 500);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw capabilityError('capability_response_invalid', '图片能力接口没有返回有效 JSON。');
  }
  const capability = normalizeImageCapabilities(payload);
  return {
    capability,
    etag: normalizeETag(response.headers && response.headers.get && response.headers.get('etag')) || `"${capability.revision}"`
  };
}

export function normalizeImageCapabilities(payload) {
  if (!isObject(payload) || payload.object !== 'gpteam.image_capabilities') {
    throw capabilityError('capability_response_invalid', '图片能力响应对象无效。');
  }
  if (payload.schema_version !== SCHEMA_VERSION) {
    throw capabilityError('capability_schema_unsupported', `不支持图片能力 schema ${String(payload.schema_version)}。`);
  }
  const revision = nonEmptyString(payload.revision);
  const observedAt = validDateString(payload.observed_at);
  const apiKeyID = positiveInteger(payload.api_key && payload.api_key.id);
  const group = normalizeGroup(payload.group);
  const imageMCP = normalizeImageMCP(payload.image_mcp, group.platform);
  if (!revision || !observedAt || !apiKeyID) {
    throw capabilityError('capability_response_invalid', '图片能力响应缺少稳定身份或观测信息。');
  }
  return {
    object: 'gpteam.image_capabilities',
    schema_version: SCHEMA_VERSION,
    revision,
    observed_at: observedAt,
    api_key: { id: apiKeyID },
    group,
    enabled: imageMCP.enabled,
    blocking_reasons: imageMCP.blocking_reasons,
    default_models: imageMCP.default_models,
    tools: imageMCP.tools,
    max_concurrent_jobs: imageMCP.max_concurrent_jobs,
    max_queued_jobs: imageMCP.max_queued_jobs,
    models: imageMCP.models,
    availability: normalizeAvailability(payload.availability)
  };
}

function normalizeGroup(raw) {
  const id = positiveInteger(raw && raw.id);
  const name = nonEmptyString(raw && raw.name);
  const platform = nonEmptyString(raw && raw.platform).toLowerCase();
  if (!id || !name || !platform) throw capabilityError('capability_response_invalid', '图片能力分组摘要无效。');
  return { id, name, platform };
}

function normalizeImageMCP(raw, platform) {
  if (!isObject(raw) || typeof raw.enabled !== 'boolean') {
    throw capabilityError('capability_response_invalid', 'image_mcp 能力对象无效。');
  }
  const blockingReasons = uniqueStrings(raw.blocking_reasons);
  const tools = uniqueStrings(raw.tools);
  const maxConcurrentJobs = positiveInteger(raw.max_concurrent_jobs);
  const maxQueuedJobs = nonNegativeInteger(raw.max_queued_jobs);
  if (!Array.isArray(raw.blocking_reasons) || !sameStrings(tools, REQUIRED_TOOLS) || !maxConcurrentJobs || maxQueuedJobs === null) {
    throw capabilityError('capability_response_invalid', 'image_mcp 队列或工具合同无效。');
  }
  const models = normalizeModels(raw.models, platform);
  const defaultModels = normalizeDefaultModels(raw.default_models, models);
  if (raw.enabled) {
    if (blockingReasons.length || !models.length || !Object.keys(defaultModels).length) {
      throw capabilityError('capability_response_invalid', '已启用的 image_mcp 能力不完整。');
    }
  } else if (models.length || Object.keys(defaultModels).length) {
    throw capabilityError('capability_response_invalid', '已禁用的 image_mcp 能力包含可执行模型。');
  }
  return {
    enabled: raw.enabled,
    blocking_reasons: blockingReasons,
    default_models: defaultModels,
    tools,
    max_concurrent_jobs: maxConcurrentJobs,
    max_queued_jobs: maxQueuedJobs,
    models
  };
}

function normalizeModels(raw, platform) {
  if (!Array.isArray(raw)) throw capabilityError('capability_response_invalid', '图片模型列表无效。');
  const seen = new Set();
  return raw.map((item) => {
    const id = nonEmptyString(item && item.id);
    if (!id || seen.has(id) || nonEmptyString(item.platform).toLowerCase() !== platform ||
      !positiveInteger(item.contract_revision) || item.eligible !== true || item.routable_by_contract !== true) {
      throw capabilityError('capability_response_invalid', '图片模型合同无效。');
    }
    seen.add(id);
    const actions = normalizeActions(item.actions);
    if (!Object.keys(actions).length) throw capabilityError('capability_response_invalid', `模型 ${id} 没有可执行动作。`);
    return {
      id,
      platform,
      aliases: uniqueStrings(item.aliases || []),
      contract_revision: positiveInteger(item.contract_revision),
      actions
    };
  });
}

function normalizeActions(raw) {
  if (!isObject(raw)) throw capabilityError('capability_response_invalid', '图片动作合同无效。');
  const result = {};
  for (const [action, contract] of Object.entries(raw)) {
    const dedicatedEndpoint = action === 'generate'
      ? '/v1/gpteam/image-mcp/images/generations'
      : '/v1/gpteam/image-mcp/images/edits';
    const endpointAllowed = contract && contract.endpoint === dedicatedEndpoint;
    if (!['generate', 'edit'].includes(action) || !isObject(contract) || contract.eligible !== true || !endpointAllowed) {
      throw capabilityError('capability_response_invalid', `图片动作 ${action} 无效。`);
    }
    const profiles = normalizeProfiles(contract.execution_profiles);
    if (!profiles.length) throw capabilityError('capability_response_invalid', `图片动作 ${action} 没有执行配置。`);
    result[action] = { endpoint: contract.endpoint, profiles };
  }
  return result;
}

function normalizeProfiles(raw) {
  if (!Array.isArray(raw)) throw capabilityError('capability_response_invalid', '图片执行配置列表无效。');
  const seen = new Set();
  return raw.map((profile) => {
    const id = nonEmptyString(profile && profile.id);
    const priority = positiveInteger(profile && profile.default_priority);
    const provenance = nonEmptyString(profile && profile.provenance);
    if (!id || seen.has(id) || !priority || profile.eligible !== true ||
      !['verified_builtin', 'verified_upstream_discovery'].includes(provenance)) {
      throw capabilityError('capability_response_invalid', '图片执行配置无效。');
    }
    seen.add(id);
    return {
      id,
      default_priority: priority,
      provenance,
      parameters: normalizeParameters(profile.parameters)
    };
  }).sort((left, right) => left.default_priority - right.default_priority || left.id.localeCompare(right.id));
}

function normalizeParameters(raw) {
  if (!Array.isArray(raw)) throw capabilityError('capability_response_invalid', '图片参数合同无效。');
  const seen = new Set();
  return raw.map((parameter) => {
    const name = nonEmptyString(parameter && parameter.name);
    const type = nonEmptyString(parameter && parameter.type);
    const description = nonEmptyString(parameter && parameter.description);
    if (!name || seen.has(name) || !description || !['string', 'integer', 'boolean', 'string_array'].includes(type) ||
      typeof parameter.required !== 'boolean' ||
      !['forwarded', 'mcp_local'].includes(parameter.ownership) ||
      !['upstream_effective', 'gpteam_effective'].includes(parameter.effect)) {
      throw capabilityError('capability_response_invalid', `图片参数 ${name || '<empty>'} 无效。`);
    }
    seen.add(name);
    const normalized = {
      name,
      description,
      type,
      required: parameter.required === true,
      ownership: parameter.ownership,
      effect: parameter.effect
    };
    normalizeParameterEnum(parameter, normalized);
    normalizeParameterBounds(parameter, normalized);
    if (parameter.accepted_forms !== undefined) {
      if (type !== 'string' || normalized.enum) throw invalidParameterContract(name);
      normalized.accepted_forms = normalizeAcceptedForms(parameter.accepted_forms);
    }
    if (Object.prototype.hasOwnProperty.call(parameter, 'default')) {
      if (!validParameterContractValue(normalized, parameter.default)) throw invalidParameterContract(name);
      normalized.default = cloneCapability(parameter.default);
    }
    return normalized;
  });
}

function normalizeParameterEnum(parameter, normalized) {
  if (parameter.enum === undefined) return;
  if (!['string', 'string_array'].includes(normalized.type) || !Array.isArray(parameter.enum) || !parameter.enum.length) {
    throw invalidParameterContract(normalized.name);
  }
  const values = strictUniqueStrings(parameter.enum);
  if (!values) throw invalidParameterContract(normalized.name);
  normalized.enum = values;
}

function normalizeParameterBounds(parameter, normalized) {
  const hasMinimum = parameter.minimum !== undefined;
  const hasMaximum = parameter.maximum !== undefined;
  if ((hasMinimum || hasMaximum) && normalized.type !== 'integer') throw invalidParameterContract(normalized.name);
  if (hasMinimum) normalized.minimum = finiteNonNegativeInteger(parameter.minimum, normalized.name);
  if (hasMaximum) normalized.maximum = finiteNonNegativeInteger(parameter.maximum, normalized.name);
  if (hasMinimum && hasMaximum && normalized.minimum > normalized.maximum) throw invalidParameterContract(normalized.name);

  const hasMinimumItems = parameter.minimum_items !== undefined;
  const hasMaximumItems = parameter.maximum_items !== undefined;
  if ((hasMinimumItems || hasMaximumItems) && normalized.type !== 'string_array') throw invalidParameterContract(normalized.name);
  if (hasMinimumItems) normalized.minimum_items = finiteNonNegativeInteger(parameter.minimum_items, normalized.name);
  if (hasMaximumItems) normalized.maximum_items = finiteNonNegativeInteger(parameter.maximum_items, normalized.name);
  if (hasMinimumItems && hasMaximumItems && normalized.minimum_items > normalized.maximum_items) {
    throw invalidParameterContract(normalized.name);
  }
}

function finiteNonNegativeInteger(value, name) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalidParameterContract(name);
  return value;
}

function validParameterContractValue(parameter, value) {
  if (parameter.type === 'string' && typeof value !== 'string') return false;
  if (parameter.type === 'integer' && !Number.isSafeInteger(value)) return false;
  if (parameter.type === 'boolean' && typeof value !== 'boolean') return false;
  if (parameter.type === 'string_array' &&
    (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) return false;
  if (parameter.enum) {
    if (parameter.type === 'string' && !parameter.enum.includes(value)) return false;
    if (parameter.type === 'string_array' && value.some((item) => !parameter.enum.includes(item))) return false;
  }
  if (parameter.minimum !== undefined && value < parameter.minimum) return false;
  if (parameter.maximum !== undefined && value > parameter.maximum) return false;
  if (parameter.minimum_items !== undefined && value.length < parameter.minimum_items) return false;
  if (parameter.maximum_items !== undefined && value.length > parameter.maximum_items) return false;
  return !parameter.accepted_forms || matchesAcceptedFormContract(value, parameter.accepted_forms.one_of);
}

function strictUniqueStrings(values) {
  const result = [];
  for (const value of values) {
    const normalized = nonEmptyString(value);
    if (!normalized || normalized !== value || result.includes(normalized)) return null;
    result.push(normalized);
  }
  return result;
}

function invalidParameterContract(name) {
  return capabilityError('capability_response_invalid', `图片参数 ${name || '<empty>'} 合同无效。`);
}

function normalizeAcceptedForms(raw) {
  if (!isObject(raw) || !Array.isArray(raw.one_of) || !raw.one_of.length) {
    throw capabilityError('capability_response_invalid', '图片字符串联合参数无效。');
  }
  const seenKinds = new Set();
  return {
    one_of: raw.one_of.map((form) => {
      if (form && form.kind === 'literals' && Array.isArray(form.literals) && form.literals.length) {
        const literals = strictUniqueStrings(form.literals);
        if (!literals || seenKinds.has(form.kind)) throw capabilityError('capability_response_invalid', '图片字符串联合参数无效。');
        seenKinds.add(form.kind);
        return { kind: 'literals', literals };
      }
      if (form && form.kind === 'dimensions' && isObject(form.dimensions)) {
        if (seenKinds.has(form.kind)) throw capabilityError('capability_response_invalid', '图片字符串联合参数无效。');
        seenKinds.add(form.kind);
        const dimensions = normalizeDimensionConstraints(form.dimensions);
        return { kind: 'dimensions', dimensions };
      }
      throw capabilityError('capability_response_invalid', '图片字符串联合参数分支无效。');
    })
  };
}

function normalizeDimensionConstraints(raw) {
  const dimensions = {
    syntax: nonEmptyString(raw.syntax),
    min_edge_px: finiteNonNegativeInteger(raw.min_edge_px, 'accepted_forms'),
    max_edge_px: finiteNonNegativeInteger(raw.max_edge_px, 'accepted_forms')
  };
  if (dimensions.syntax !== 'width_x_height' || dimensions.min_edge_px <= 0 ||
    dimensions.max_edge_px <= 0 || dimensions.min_edge_px > dimensions.max_edge_px) {
    throw capabilityError('capability_response_invalid', '图片尺寸联合参数无效。');
  }
  for (const field of ['edge_multiple_px', 'min_total_pixels', 'max_total_pixels']) {
    if (raw[field] !== undefined) dimensions[field] = finiteNonNegativeInteger(raw[field], 'accepted_forms');
  }
  if (dimensions.edge_multiple_px !== undefined && dimensions.edge_multiple_px <= 0) {
    throw capabilityError('capability_response_invalid', '图片尺寸联合参数无效。');
  }
  const hasMinimumPixels = dimensions.min_total_pixels !== undefined;
  const hasMaximumPixels = dimensions.max_total_pixels !== undefined;
  if (hasMinimumPixels !== hasMaximumPixels ||
    hasMinimumPixels && (dimensions.min_total_pixels <= 0 || dimensions.min_total_pixels > dimensions.max_total_pixels)) {
    throw capabilityError('capability_response_invalid', '图片尺寸联合参数无效。');
  }
  if (raw.max_long_to_short_ratio !== undefined) {
    if (typeof raw.max_long_to_short_ratio !== 'number' || !Number.isFinite(raw.max_long_to_short_ratio) || raw.max_long_to_short_ratio < 1) {
      throw capabilityError('capability_response_invalid', '图片尺寸联合参数无效。');
    }
    dimensions.max_long_to_short_ratio = raw.max_long_to_short_ratio;
  }
  return dimensions;
}

function matchesAcceptedFormContract(value, forms) {
  if (typeof value !== 'string') return false;
  for (const form of forms || []) {
    if (form.kind === 'literals' && form.literals.includes(value)) return true;
    if (form.kind === 'dimensions' && dimensionContractMatches(value, form.dimensions)) return true;
  }
  return false;
}

function dimensionContractMatches(value, constraints) {
  const match = String(value).trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < constraints.min_edge_px || height < constraints.min_edge_px ||
    width > constraints.max_edge_px || height > constraints.max_edge_px) return false;
  if (constraints.edge_multiple_px &&
    (width % constraints.edge_multiple_px !== 0 || height % constraints.edge_multiple_px !== 0)) return false;
  const pixels = width * height;
  if (constraints.min_total_pixels !== undefined &&
    (pixels < constraints.min_total_pixels || pixels > constraints.max_total_pixels)) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return constraints.max_long_to_short_ratio === undefined || ratio <= constraints.max_long_to_short_ratio;
}

function normalizeDefaultModels(raw, models) {
  if (!isObject(raw)) throw capabilityError('capability_response_invalid', '图片默认模型合同无效。');
  const modelMap = new Map(models.map((model) => [model.id, model]));
  const result = {};
  for (const [action, modelIDValue] of Object.entries(raw)) {
    const modelID = nonEmptyString(modelIDValue);
    const model = modelMap.get(modelID);
    if (!['generate', 'edit'].includes(action) || !model || !model.actions[action]) {
      throw capabilityError('capability_response_invalid', '图片默认模型指向无效动作。');
    }
    result[action] = modelID;
  }
  return result;
}

export function buildDynamicImageTools(capabilities) {
  const inputSchema = capabilitySupersetSchema(capabilities);
  const createDescription = '按当前 API Key 的实时能力合同创建图片任务。model 和 action 必须显式选择。';
  return [
    { name: 'create_image_job', description: createDescription, inputSchema, outputSchema: jobOutputSchema() },
    {
      name: 'get_image_job_status', description: '查询本地图片任务状态。',
      inputSchema: jobIDSchema(), outputSchema: jobOutputSchema()
    },
    {
      name: 'cancel_image_job', description: '取消仍在排队或运行的本地图片任务。',
      inputSchema: jobIDSchema(), outputSchema: jobOutputSchema()
    },
    {
      name: 'download_image_result', description: '读取已完成任务的图片文件和元数据。',
      inputSchema: downloadSchema(), outputSchema: downloadOutputSchema()
    },
    {
      name: 'get_capabilities', description: '刷新并返回当前 API Key 的图片模型、动作和参数合同。',
      inputSchema: emptySchema(), outputSchema: capabilityOutputSchema()
    },
    {
      name: 'generate_image', description: `create_image_job 的兼容异步别名。${createDescription}`,
      inputSchema, outputSchema: jobOutputSchema()
    }
  ];
}

function capabilitySupersetSchema(capabilities) {
  const models = Array.isArray(capabilities && capabilities.models) ? capabilities.models : [];
  const profiles = models.flatMap((model) =>
    Object.values(model.actions || {}).flatMap((action) => action.profiles || []));
  const properties = {
    model: { type: 'string', description: '来自当前 Key 能力合同的模型 ID。' },
    action: { type: 'string', enum: availableActions(models), description: '图片动作。' }
  };
  const modelIDs = uniqueStrings(models.map((model) => model.id));
  if (modelIDs.length) properties.model.enum = modelIDs;

  const definitions = profiles.length ? collectParameterDefinitions(profiles) : fallbackParameterDefinitions();
  for (const [name, parameters] of [...definitions.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    properties[name] = mergeParameterSchemas(parameters);
  }
  const requiredParameters = profiles.length
    ? [...definitions.entries()]
      .filter(([name]) => profiles.every((profile) =>
        profile.parameters.some((parameter) => parameter.name === name && parameter.required)))
      .map(([name]) => name)
    : ['prompt'];
  const required = ['model', 'action', ...requiredParameters];
  return { type: 'object', properties, required: uniqueStrings(required), additionalProperties: false };
}

function availableActions(models) {
  const actions = uniqueStrings(models.flatMap((model) => Object.keys(model.actions || {})));
  return actions.length ? actions : ['generate', 'edit'];
}

function collectParameterDefinitions(profiles) {
  const definitions = new Map();
  for (const profile of profiles) {
    for (const parameter of profile.parameters || []) {
      if (!definitions.has(parameter.name)) definitions.set(parameter.name, []);
      definitions.get(parameter.name).push(parameter);
    }
  }
  return definitions;
}

function fallbackParameterDefinitions() {
  return new Map([
    ['prompt', [{ name: 'prompt', type: 'string', description: '图片提示词。' }]],
    ['images', [{ name: 'images', type: 'string_array', description: '编辑动作的输入图片。', minimum_items: 1 }]],
    ['mask', [{ name: 'mask', type: 'string', description: '编辑蒙版。' }]],
    ['size', [{ name: 'size', type: 'string', description: '当前模型支持的图片尺寸或档位。' }]],
    ['quality', [{ name: 'quality', type: 'string', description: '当前模型支持的图片质量档位。' }]],
    ['aspect_ratio', [{ name: 'aspect_ratio', type: 'string', description: '当前模型支持的宽高比。' }]],
    ['output_path', [{ name: 'output_path', type: 'string', description: '本地输出路径。' }]],
    ['overwrite', [{ name: 'overwrite', type: 'boolean', description: '是否覆盖已有本地文件。', default: false }]],
    ['idempotency_key', [{ name: 'idempotency_key', type: 'string', description: '本地任务幂等标识。' }]]
  ]);
}

function mergeParameterSchemas(parameters) {
  const schemas = parameters.map(parameterJSONSchema);
  const first = schemas[0];
  if (schemas.every((schema) => JSON.stringify(schema) === JSON.stringify(first))) return first;
  const types = uniqueStrings(schemas.flatMap((schema) => Array.isArray(schema.type) ? schema.type : [schema.type]));
  const merged = {
    description: uniqueStrings(parameters.map((parameter) => parameter.description)).join(' / ')
  };
  if (types.length === 1) merged.type = types[0];
  else if (types.length) merged.type = types;
  const enums = schemas.map((schema) => schema.enum).filter(Array.isArray);
  if (enums.length === schemas.length) merged.enum = uniqueStrings(enums.flat());
  if (merged.type === 'array') mergeArraySchemaHints(merged, schemas);
  return merged;
}

function mergeArraySchemaHints(merged, schemas) {
  merged.items = { type: 'string' };
  const itemEnums = schemas.map((schema) => schema.items && schema.items.enum).filter(Array.isArray);
  if (itemEnums.length === schemas.length) merged.items.enum = uniqueStrings(itemEnums.flat());
  const minimums = schemas.map((schema) => schema.minItems).filter(Number.isInteger);
  const maximums = schemas.map((schema) => schema.maxItems).filter(Number.isInteger);
  if (minimums.length === schemas.length) merged.minItems = Math.min(...minimums);
  if (maximums.length) merged.maxItems = Math.max(...maximums);
}

export function parameterJSONSchema(parameter) {
  const schema = { description: parameter.description };
  if (parameter.type === 'string_array') {
    schema.type = 'array';
    schema.items = { type: 'string' };
    if (parameter.enum && parameter.enum.length) schema.items.enum = [...parameter.enum];
    if (parameter.minimum_items > 0) schema.minItems = parameter.minimum_items;
    if (parameter.maximum_items > 0) schema.maxItems = parameter.maximum_items;
  } else {
    schema.type = parameter.type;
    if (parameter.enum && parameter.enum.length) schema.enum = [...parameter.enum];
  }
  if (parameter.minimum !== undefined) schema.minimum = parameter.minimum;
  if (parameter.maximum !== undefined) schema.maximum = parameter.maximum;
  if (Object.prototype.hasOwnProperty.call(parameter, 'default')) schema.default = cloneCapability(parameter.default);
  if (parameter.accepted_forms) {
    schema.oneOf = parameter.accepted_forms.one_of.map((form) => form.kind === 'literals'
      ? { type: 'string', enum: [...form.literals] }
      : { type: 'string', pattern: '^\\s*[0-9]+\\s*[xX]\\s*[0-9]+\\s*$' });
  }
  return schema;
}

export function summarizeImageCapabilities(capabilities, options = {}) {
  return {
    ok: true,
    enabled: capabilities.enabled === true,
    schema_version: capabilities.schema_version,
    revision: capabilities.revision,
    observed_at: capabilities.observed_at,
    cache_age_ms: Math.max(0, Number(options.cacheAgeMS ?? capabilities.cache_age_ms) || 0),
    group: cloneCapability(capabilities.group),
    blocking_reasons: [...capabilities.blocking_reasons],
    default_models: cloneCapability(capabilities.default_models),
    models: cloneCapability(capabilities.models),
    tools: [...capabilities.tools],
    max_concurrent_jobs: capabilities.max_concurrent_jobs,
    max_queued_jobs: capabilities.max_queued_jobs
  };
}

function capabilityURL(baseUrl) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}/gpteam/image-capabilities`;
}

function capabilityOrigin(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).origin.toLowerCase();
  } catch {
    return '';
  }
}

function assertCredentials(credentials) {
  if (!credentials || !nonEmptyString(credentials.apiKey) || !capabilityOrigin(credentials.baseUrl)) {
    throw capabilityError('capability_configuration_invalid', '图片能力查询缺少有效的 GPTEAM API Key 或 Base URL。');
  }
}

function normalizeAvailability(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (!isObject(raw) || typeof raw.currently_available !== 'boolean' || !validDateString(raw.observed_at)) {
    throw capabilityError('capability_response_invalid', '图片可用性观测无效。');
  }
  return { currently_available: raw.currently_available, observed_at: raw.observed_at };
}

function capabilityError(code, message, retryable = false, details) {
  return new ImageMCPError(message, {
    code, category: code.includes('auth') ? 'authentication' : 'capability',
    stage: 'capability', retryable, details
  });
}

function jobIDSchema() {
  return {
    type: 'object',
    properties: { job_id: { type: 'string', description: 'create_image_job 返回的任务 ID。' } },
    required: ['job_id'], additionalProperties: false
  };
}

function downloadSchema() {
  const schema = jobIDSchema();
  schema.properties.metadata_only = { type: 'boolean', default: true };
  schema.properties.include_image = { type: 'boolean', default: false };
  schema.properties.include_revised_prompt = { type: 'boolean', default: true };
  return schema;
}

function emptySchema() {
  return { type: 'object', properties: {}, additionalProperties: false };
}

function jobOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      status: { type: 'string' },
      job_id: { type: 'string' },
      trace_id: { type: 'string' },
      model: { type: 'string' },
      action: { type: 'string' },
      capability_revision: { type: 'string' },
      error: errorOutputSchema()
    },
    required: ['ok'],
    additionalProperties: true
  };
}

function downloadOutputSchema() {
  const schema = jobOutputSchema();
  Object.assign(schema.properties, {
    file: { type: 'string' },
    format: { type: 'string' },
    mime_type: { type: 'string' },
    bytes: { type: 'integer' },
    sha256: { type: 'string' }
  });
  return schema;
}

function capabilityOutputSchema() {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      enabled: { type: 'boolean' },
      schema_version: { type: 'integer' },
      revision: { type: 'string' },
      observed_at: { type: 'string' },
      cache_age_ms: { type: 'integer' },
      blocking_reasons: { type: 'array', items: { type: 'string' } },
      group: { type: 'object', additionalProperties: true },
      default_models: { type: 'object', additionalProperties: true },
      models: { type: 'array', items: { type: 'object', additionalProperties: true } },
      error: errorOutputSchema()
    },
    required: ['ok'],
    additionalProperties: true
  };
}

function errorOutputSchema() {
  return {
    type: 'object',
    properties: {
      code: { type: 'string' },
      message: { type: 'string' },
      retryable: { type: 'boolean' },
      stage: { type: 'string' },
      category: { type: 'string' }
    },
    additionalProperties: true
  };
}

function etagMatches(response, expected) {
  const actual = normalizeETag(response && response.headers && response.headers.get && response.headers.get('etag'));
  return !actual || actual === normalizeETag(expected);
}

function normalizeETag(value) {
  return nonEmptyString(value);
}

function normalizeHMACKey(value) {
  if (Buffer.isBuffer(value) && value.length >= 16) return value;
  if (typeof value === 'string' && value.length >= 16) return Buffer.from(value);
  return crypto.randomBytes(32);
}

function timeoutSignal(value) {
  const timeoutMS = positiveInteger(value) || 15_000;
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMS)
    : undefined;
}

function sameStrings(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function uniqueStrings(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = nonEmptyString(value);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function cloneCapability(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function validDateString(value) {
  const text = nonEmptyString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function nonEmptyString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
