import { ImageMCPError } from './errors.js';

const selectorFields = new Set(['model', 'action']);

export function normalizeCapabilityRequest(input = {}, capabilities, options = {}) {
  if (!capabilities || capabilities.enabled !== true || !Array.isArray(capabilities.models)) {
    throw validationError('capability_empty', '当前 API Key 没有可执行的图片能力。');
  }
  const modelID = stringValue(input.model);
  if (!modelID) throw validationError('model_required', 'model 必须从 get_capabilities 返回结果中显式选择。', 'model');
  const model = resolveModel(capabilities.models, modelID);
  if (!model) throw validationError('model_unsupported', `当前 API Key 不支持图片模型 ${modelID}。`, 'model');

  const action = stringValue(input.action);
  if (!action) throw validationError('action_required', 'action 必须显式选择 generate 或 edit。', 'action');
  const actionContract = model.actions && model.actions[action];
  if (!actionContract) throw validationError('action_unsupported', `模型 ${model.id} 不支持动作 ${action}。`, 'action');

  const normalizedInput = normalizeCompatibilityAliases(input, action);
  const candidates = [];
  const failures = [];
  for (const profile of actionContract.profiles || []) {
    try {
      candidates.push(normalizeForProfile(normalizedInput, profile, { ...options, platform: model.platform }));
    } catch (error) {
      failures.push(error);
    }
  }
  if (!candidates.length) throw selectBestFailure(failures);
  const selected = candidates[0];
  return {
    model: model.id,
    requested_model: modelID,
    action,
    endpoint: actionContract.endpoint,
    profile_id: selected.profileID,
    parameters: selected.parameters,
    forwarded_parameters: selected.forwarded,
    mcp_local_parameters: selected.local,
    revision: capabilities.revision,
    contract_revision: model.contract_revision,
    idempotency_identity: stringValue(selected.parameters.idempotency_key)
  };
}

export function validateFrozenCapability(snapshot, freshCapabilities) {
  const normalized = normalizeCapabilityRequest({
    model: snapshot.model,
    action: snapshot.action,
    ...snapshot.parameters
  }, freshCapabilities);
  if (freshCapabilities.revision !== snapshot.revision || normalized.profile_id !== snapshot.profile_id ||
    normalized.contract_revision !== snapshot.contract_revision ||
    JSON.stringify(normalized.parameters) !== JSON.stringify(snapshot.parameters)) {
    throw validationError('stale_capability', '图片能力在任务排队期间已变化，任务未发送到上游。');
  }
  return normalized;
}

function normalizeForProfile(input, profile, options) {
  const parameters = new Map((profile.parameters || []).map((parameter) => [parameter.name, parameter]));
  const explicitFields = new Set(
    Object.entries(input || {}).filter(([, value]) => value !== undefined).map(([name]) => name)
  );
  const normalized = {};
  const forwarded = {};
  const local = {};
  for (const [name, value] of Object.entries(input || {})) {
    if (value === undefined) continue;
    if (selectorFields.has(name) || compatibilityAliasNames().has(name)) continue;
    const parameter = parameters.get(name);
    if (!parameter) throw validationError('unsupported_parameter', `当前模型和动作不支持参数 ${name}。`, name, value);
    const normalizedValue = validateParameterValue(parameter, canonicalizeKnownAlias(parameter, value, options));
    assignParameter(parameter, normalizedValue, normalized, forwarded, local);
  }
  synchronizeFormatParameters(parameters, explicitFields, normalized, forwarded, local);
  deriveAspectRatio(parameters, explicitFields, normalized, forwarded, local);
  for (const parameter of parameters.values()) {
    if (!Object.prototype.hasOwnProperty.call(normalized, parameter.name) &&
      Object.prototype.hasOwnProperty.call(parameter, 'default')) {
      const value = clone(parameter.default);
      assignParameter(parameter, value, normalized, forwarded, local);
    }
    if (parameter.required && !hasRequiredValue(normalized[parameter.name], parameter.type)) {
      throw validationError('parameter_required', `参数 ${parameter.name} 不能为空。`, parameter.name);
    }
  }
  assertFormatConsistency(normalized);
  if (options.requirePrompt !== false && !stringValue(normalized.prompt)) {
    throw validationError('parameter_required', 'prompt 不能为空。', 'prompt');
  }
  return { profileID: profile.id, parameters: normalized, forwarded, local };
}

function synchronizeFormatParameters(parameters, explicitFields, normalized, forwarded, local) {
  const formatParameter = parameters.get('format');
  const outputFormatParameter = parameters.get('output_format');
  if (!formatParameter || !outputFormatParameter) return;

  const hasFormat = explicitFields.has('format');
  const hasOutputFormat = explicitFields.has('output_format');
  if (hasFormat && hasOutputFormat) {
    assertFormatConsistency(normalized);
    return;
  }

  if (hasFormat) {
    assignParameter(
      outputFormatParameter,
      validateParameterValue(outputFormatParameter, normalized.format),
      normalized,
      forwarded,
      local
    );
  } else if (hasOutputFormat) {
    assignParameter(
      formatParameter,
      validateParameterValue(formatParameter, normalized.output_format),
      normalized,
      forwarded,
      local
    );
  }
}

function assertFormatConsistency(normalized) {
  if (!Object.prototype.hasOwnProperty.call(normalized, 'format') ||
    !Object.prototype.hasOwnProperty.call(normalized, 'output_format') ||
    normalized.format === normalized.output_format) return;
  throw validationError(
    'unsupported_parameter',
    'format 和 output_format 不能互相冲突。',
    'output_format',
    normalized.output_format
  );
}

function deriveAspectRatio(parameters, explicitFields, normalized, forwarded, local) {
  if (!explicitFields.has('size') || explicitFields.has('aspect_ratio')) return;
  const aspectRatioParameter = parameters.get('aspect_ratio');
  if (!aspectRatioParameter || !Array.isArray(aspectRatioParameter.enum)) return;
  const aspectRatio = reducedAspectRatio(normalized.size);
  if (!aspectRatio || !aspectRatioParameter.enum.includes(aspectRatio)) return;
  assignParameter(
    aspectRatioParameter,
    validateParameterValue(aspectRatioParameter, aspectRatio),
    normalized,
    forwarded,
    local
  );
}

function reducedAspectRatio(value) {
  if (typeof value !== 'string') return '';
  const match = value.trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match) return '';
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return '';
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function greatestCommonDivisor(left, right) {
  let dividend = left;
  let divisor = right;
  while (divisor !== 0) {
    const remainder = dividend % divisor;
    dividend = divisor;
    divisor = remainder;
  }
  return dividend;
}

function assignParameter(parameter, value, normalized, forwarded, local) {
  normalized[parameter.name] = value;
  (parameter.ownership === 'mcp_local' ? local : forwarded)[parameter.name] = value;
}

function canonicalizeKnownAlias(parameter, value, options) {
  if (options.platform !== 'gemini' || parameter.name !== 'size' || typeof value !== 'string' ||
    !Array.isArray(parameter.enum)) return value;
  const match = value.trim().match(/^([124])k$/i);
  if (!match) return value;
  const canonical = `${match[1]}K`;
  return parameter.enum.includes(canonical) ? canonical : value;
}

function validateParameterValue(parameter, value) {
  if (value === undefined) {
    if (parameter.required) throw validationError('parameter_required', `参数 ${parameter.name} 不能为空。`, parameter.name);
    return value;
  }
  if (value === null) return invalidParameter(parameter, value);
  switch (parameter.type) {
  case 'string':
    if (typeof value !== 'string') return invalidParameter(parameter, value);
    break;
  case 'integer':
    if (!Number.isInteger(value)) return invalidParameter(parameter, value);
    break;
  case 'boolean':
    if (typeof value !== 'boolean') return invalidParameter(parameter, value);
    break;
  case 'string_array':
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return invalidParameter(parameter, value);
    break;
  default:
    return invalidParameter(parameter, value);
  }
  if (parameter.enum && parameter.enum.length) {
    const unsupported = parameter.type === 'string_array'
      ? value.some((item) => !parameter.enum.includes(item))
      : !parameter.enum.includes(value);
    if (unsupported) return invalidParameter(parameter, value);
  }
  if (parameter.minimum !== undefined && value < parameter.minimum) return invalidParameter(parameter, value);
  if (parameter.maximum !== undefined && value > parameter.maximum) return invalidParameter(parameter, value);
  if (parameter.minimum_items > 0 && value.length < parameter.minimum_items) return invalidParameter(parameter, value);
  if (parameter.maximum_items > 0 && value.length > parameter.maximum_items) return invalidParameter(parameter, value);
  if (parameter.accepted_forms && !matchesAcceptedForms(value, parameter.accepted_forms.one_of)) {
    return invalidParameter(parameter, value);
  }
  return clone(value);
}

function matchesAcceptedForms(value, forms) {
  if (typeof value !== 'string') return false;
  for (const form of forms || []) {
    if (form.kind === 'literals' && form.literals.includes(value)) return true;
    if (form.kind === 'dimensions' && dimensionsMatch(value, form.dimensions)) return true;
  }
  return false;
}

function dimensionsMatch(value, constraints) {
  const match = String(value).trim().match(/^(\d+)\s*[xX]\s*(\d+)$/);
  if (!match || !constraints) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < constraints.min_edge_px || height < constraints.min_edge_px ||
    width > constraints.max_edge_px || height > constraints.max_edge_px) return false;
  if (constraints.edge_multiple_px > 0 &&
    (width % constraints.edge_multiple_px !== 0 || height % constraints.edge_multiple_px !== 0)) return false;
  const pixels = width * height;
  if (constraints.min_total_pixels > 0 &&
    (pixels < constraints.min_total_pixels || pixels > constraints.max_total_pixels)) return false;
  const ratio = Math.max(width, height) / Math.min(width, height);
  return !(constraints.max_long_to_short_ratio > 0 && ratio > constraints.max_long_to_short_ratio);
}

function normalizeCompatibilityAliases(input, action) {
  const normalized = { ...input };
  if (action === 'edit' && !Object.prototype.hasOwnProperty.call(normalized, 'images')) {
    const images = [];
    appendAlias(images, input.image);
    appendAlias(images, input.image_path);
    appendAlias(images, input.input_image);
    appendAlias(images, input.image_paths);
    appendAlias(images, input.input_images);
    if (images.length) normalized.images = images;
  }
  if (action === 'edit' && !Object.prototype.hasOwnProperty.call(normalized, 'mask') && input.mask_path !== undefined) {
    normalized.mask = input.mask_path;
  }
  return normalized;
}

function appendAlias(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) appendAlias(target, item);
    return;
  }
  if (typeof value === 'string' && value.trim()) target.push(value);
}

function resolveModel(models, requested) {
  return models.find((model) => model.id === requested) ||
    models.find((model) => Array.isArray(model.aliases) && model.aliases.includes(requested));
}

function compatibilityAliasNames() {
  return new Set(['image', 'image_path', 'image_paths', 'input_image', 'input_images', 'mask_path']);
}

function hasRequiredValue(value, type) {
  if (type === 'string') return typeof value === 'string' && value.trim() !== '';
  if (type === 'string_array') return Array.isArray(value) && value.length > 0;
  return value !== undefined && value !== null;
}

function invalidParameter(parameter, received) {
  throw validationError(
    'unsupported_parameter',
    `参数 ${parameter.name} 不符合当前模型和动作的能力合同。`,
    parameter.name,
    received
  );
}

function selectBestFailure(failures) {
  return failures.find((error) => error.code === 'unsupported_parameter') ||
    failures.find((error) => error.code === 'parameter_required') ||
    failures[0] || validationError('capability_response_invalid', '没有可用的图片执行配置。');
}

function validationError(code, message, field = '', received) {
  return new ImageMCPError(message, {
    code,
    category: code === 'stale_capability' ? 'capability' : 'parameter',
    stage: code === 'stale_capability' ? 'capability' : 'validate',
    retryable: false,
    details: { field, received }
  });
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
