import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDynamicImageTools,
  capabilityCacheIdentity,
  createCapabilityCache,
  fetchImageCapabilities,
  normalizeImageCapabilities,
  summarizeImageCapabilities
} from '../lib/image-mcp/capabilities.js';
import { normalizeCapabilityRequest } from '../lib/image-mcp/validation.js';
import { buildImageGenerationPayload, createImageJobStore, getImageJobStatus } from '../lib/image-mcp/image.js';
import { callImageTool, listImageTools } from '../lib/image-mcp/server.js';

const credentialsA = {
  apiKey: 'synthetic-key-a',
  baseUrl: 'https://api.example.test/v1'
};

test('dedicated schema-v1 fetch is authenticated, cached for at most 60 seconds, and singleflight', async () => {
  let now = 1_000;
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const cache = createCapabilityCache({ now: () => now, maxAgeMS: 120_000, hmacKey: Buffer.alloc(32, 7) });
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(String(url), 'https://api.example.test/v1/gpteam/image-capabilities');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key-a');
    assert.equal(init.redirect, 'manual');
    await waiting;
    return jsonResponse(capabilityFixture());
  };

  const first = fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl });
  const concurrent = fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl });
  release();
  assert.equal((await first).revision, 'revision-a');
  assert.equal((await concurrent).revision, 'revision-a');
  assert.equal(calls, 1);

  now += 59_999;
  await fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl });
  assert.equal(calls, 1);
  now += 2;
  await fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl });
  assert.equal(calls, 2, 'cache age must be capped at 60 seconds');
});

test('cache identity is process-local, HMAC-isolated by key, and never contains raw credentials', () => {
  const hmacKey = Buffer.alloc(32, 3);
  const first = capabilityCacheIdentity(credentialsA, hmacKey);
  const second = capabilityCacheIdentity({ ...credentialsA, apiKey: 'synthetic-key-b' }, hmacKey);
  assert.notEqual(first, second);
  assert.doesNotMatch(first, /synthetic-key|api\.example/);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test('fresh refresh sends the previous revision and accepts only a matching 304 cache entry', async () => {
  let request = 0;
  const cache = createCapabilityCache({ hmacKey: Buffer.alloc(32, 9) });
  const fetchImpl = async (_url, init) => {
    request += 1;
    if (request === 1) return jsonResponse(capabilityFixture(), { etag: '"revision-a"' });
    assert.equal(init.headers['If-None-Match'], '"revision-a"');
    return { ok: false, status: 304, headers: headers({ etag: '"revision-a"' }) };
  };
  const first = await fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl });
  const second = await fetchImageCapabilities(credentialsA, { cache, fetch: fetchImpl, forceRefresh: true });
  assert.equal(first.revision, second.revision);
  assert.equal(request, 2);
});

test('auth, empty, malformed, unsupported schema, redirect, and refresh failures fail closed', async () => {
  const cases = [
    ['authentication', { ok: false, status: 401, text: async () => 'bad key' }, 'capability_authentication_failed'],
    ['permission', { ok: false, status: 403, text: async () => 'group disabled' }, 'capability_permission_denied'],
    ['redirect', { ok: false, status: 302, headers: headers({ location: 'https://other.example/' }) }, 'capability_redirect_rejected'],
    ['malformed', jsonResponse({ object: 'gpteam.image_capabilities', schema_version: 1 }), 'capability_response_invalid'],
    ['unsupported schema', jsonResponse({ ...capabilityFixture(), schema_version: 2 }), 'capability_schema_unsupported'],
    ['empty capability', jsonResponse(capabilityFixture({ image_mcp: disabledImageMCP() })), 'capability_empty']
  ];
  for (const [name, response, code] of cases) {
    await assert.rejects(
      fetchImageCapabilities(credentialsA, {
        cache: createCapabilityCache(),
        fetch: async () => response
      }),
      (error) => error.code === code,
      name
    );
  }

  const cache = createCapabilityCache();
  await fetchImageCapabilities(credentialsA, { cache, fetch: async () => jsonResponse(capabilityFixture()) });
  await assert.rejects(
    fetchImageCapabilities(credentialsA, {
      cache,
      forceRefresh: true,
      fetch: async () => { throw new TypeError('network down'); }
    }),
    (error) => error.code === 'capability_fetch_failed'
  );
});

test('legacy fallback is bounded to an explicit trusted GPTEAM summary and gpt-image-2', async () => {
  const fetch404 = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  const recognizedSummary = {
    image_mcp: {
      enabled: true,
      schema_version: 1,
      default_model: 'gpt-image-2',
      tools: ['create_image_job', 'get_image_job_status', 'download_image_result', 'cancel_image_job', 'get_capabilities'],
      max_concurrent_jobs: 2,
      max_queued_jobs: 20
    }
  };
  const fallback = await fetchImageCapabilities(credentialsA, {
    cache: createCapabilityCache(),
    fetch: fetch404,
    allowLegacyFallback: true,
    trustedLegacyOrigin: 'https://api.example.test',
    legacySummary: recognizedSummary
  });
  assert.equal(fallback.legacy, true);
  assert.deepEqual(fallback.models.map((model) => model.id), ['gpt-image-2']);

  const urls = [];
  const fetchedFallback = await fetchImageCapabilities(credentialsA, {
    cache: createCapabilityCache(), allowLegacyFallback: true,
    trustedLegacyOrigin: 'https://api.example.test',
    fetch: async (url) => {
      urls.push(String(url));
      return urls.length === 1 ? await fetch404() : jsonResponse(recognizedSummary);
    }
  });
  assert.equal(fetchedFallback.legacy, true);
  assert.deepEqual(urls, [
    'https://api.example.test/v1/gpteam/image-capabilities',
    'https://api.example.test/v1/gpteam/config-capabilities'
  ]);

  for (const override of [
    { allowLegacyFallback: false },
    { trustedLegacyOrigin: 'https://wrong.example' },
    { legacySummary: { image_mcp: { enabled: true, default_model: 'other-image' } } }
  ]) {
    await assert.rejects(
      fetchImageCapabilities(credentialsA, {
        cache: createCapabilityCache(), fetch: fetch404,
        allowLegacyFallback: true,
        trustedLegacyOrigin: 'https://api.example.test',
        legacySummary: {},
        ...override
      }),
      (error) => error.code === 'capability_endpoint_unavailable'
    );
  }
});

test('normalization preserves action-specific profiles and dynamic Gemini parameters', () => {
  const capabilities = normalizeImageCapabilities(capabilityFixture({
    group: { id: 9, name: 'Gemini 图片', platform: 'gemini' },
    image_mcp: imageMCPFixture({
      default_models: { generate: 'gemini-3-pro-image', edit: 'gemini-3-pro-image' },
      models: [modelFixture({
        id: 'gemini-3-pro-image',
        platform: 'gemini',
        generateParameters: [
          parameter('prompt', 'string', { required: true }),
          parameter('size', 'string', { enum: ['1K', '2K', '4K'], default: '1K' }),
          parameter('aspect_ratio', 'string', { enum: ['1:1', '16:9'], default: '1:1' })
        ],
        editParameters: [
          parameter('prompt', 'string', { required: true }),
          parameter('images', 'string_array', { required: true, minimum_items: 1 })
        ]
      })]
    })
  }));
  const model = capabilities.models[0];
  assert.deepEqual(model.actions.generate.profiles[0].parameters.find((item) => item.name === 'size').enum, ['1K', '2K', '4K']);
  assert.equal(model.actions.edit.profiles[0].parameters.some((item) => item.name === 'images'), true);
  assert.equal(model.actions.edit.profiles[0].parameters.some((item) => item.name === 'size'), false);
});

test('contract-driven payload forwards only the selected provider profile parameters', () => {
  const capabilities = normalizeImageCapabilities(capabilityFixture({
    group: { id: 9, name: 'Gemini 图片', platform: 'gemini' },
    image_mcp: imageMCPFixture({
      default_models: { generate: 'gemini-3-pro-image', edit: 'gemini-3-pro-image' },
      models: [modelFixture({
        id: 'gemini-3-pro-image', platform: 'gemini',
        generateParameters: [
          parameter('prompt', 'string', { required: true }),
          parameter('size', 'string', { enum: ['1K', '2K', '4K'], default: '1K' }),
          parameter('aspect_ratio', 'string', { enum: ['1:1', '16:9'], default: '1:1' })
        ],
        editParameters: [
          parameter('prompt', 'string', { required: true }),
          parameter('images', 'string_array', { required: true, minimum_items: 1 })
        ]
      })]
    })
  }));
  const normalized = normalizeCapabilityRequest({
    model: 'gemini-3-pro-image', action: 'generate', prompt: '画一只猫', size: '4K', aspect_ratio: '16:9'
  }, capabilities);
  assert.deepEqual(buildImageGenerationPayload(normalized.parameters, { normalizedRequest: normalized }), {
    model: 'gemini-3-pro-image', prompt: '画一只猫', size: '4K', aspect_ratio: '16:9'
  });
});

test('dynamic tools advertise explicit model/action oneOf branches and safe intersection fallback', () => {
  const capabilities = normalizeImageCapabilities(capabilityFixture());
  capabilities.models[0].actions.generate.profiles.push({
    ...structuredClone(capabilities.models[0].actions.generate.profiles[0]),
    id: 'profile-b'
  });
  const tools = buildDynamicImageTools(capabilities, { supportsOneOf: true });
  const create = tools.find((tool) => tool.name === 'create_image_job');
  assert.equal(create.inputSchema.oneOf.length, 2, 'identical provider profiles must not create overlapping oneOf branches');
  assert.equal(create.inputSchema.oneOf[0].required.includes('model'), true);
  assert.equal(create.inputSchema.oneOf[0].required.includes('action'), true);
  assert.equal(create.inputSchema.oneOf.some((branch) => branch.properties.aspect_ratio), true);

  const fallback = buildDynamicImageTools(capabilities, { supportsOneOf: false })
    .find((tool) => tool.name === 'create_image_job').inputSchema;
  assert.deepEqual(fallback.required, ['model', 'action', 'prompt']);
  assert.deepEqual(fallback.properties.model.enum, ['gpt-image-2']);
  assert.equal(fallback.additionalProperties, false);
  assert.equal(fallback.properties.images, undefined, 'action-only fields cannot be widened into the intersection');
});

test('contract validator applies defaults and rejects model, action, parameter, enum, bounds, and dimensions', () => {
  const capabilities = normalizeImageCapabilities(capabilityFixture());
  const valid = normalizeCapabilityRequest({
    model: 'gpt-image-2', action: 'generate', prompt: '画一只猫', size: '2048x1152'
  }, capabilities);
  assert.equal(valid.parameters.quality, 'high');
  assert.equal(valid.parameters.size, '2048x1152');
  assert.equal(valid.revision, 'revision-a');

  const cases = [
    [{ model: 'missing', action: 'generate', prompt: 'x' }, 'model_unsupported'],
    [{ model: 'gpt-image-2', action: 'video', prompt: 'x' }, 'action_unsupported'],
    [{ model: 'gpt-image-2', action: 'generate', prompt: 'x', images: ['x'] }, 'unsupported_parameter'],
    [{ model: 'gpt-image-2', action: 'generate', prompt: 'x', quality: 'ultra' }, 'unsupported_parameter'],
    [{ model: 'gpt-image-2', action: 'generate', prompt: 'x', output_compression: 101 }, 'unsupported_parameter'],
    [{ model: 'gpt-image-2', action: 'generate', prompt: 'x', size: '480x3840' }, 'unsupported_parameter'],
    [{ action: 'generate', prompt: 'x' }, 'model_required']
  ];
  for (const [input, code] of cases) {
    assert.throws(() => normalizeCapabilityRequest(input, capabilities), (error) => error.code === code);
  }
});

test('schema-v1 parser rejects malformed numeric bounds, defaults, enums, and compatibility-only fields', () => {
  const cases = [
    ['NaN minimum', 'generate', 'output_compression', (parameter) => { parameter.minimum = Number.NaN; }],
    ['infinite maximum', 'generate', 'output_compression', (parameter) => { parameter.maximum = Number.POSITIVE_INFINITY; }],
    ['negative numeric bound', 'generate', 'output_compression', (parameter) => { parameter.minimum = -1; }],
    ['fractional integer bound', 'generate', 'output_compression', (parameter) => { parameter.minimum = 0.5; }],
    ['reversed numeric range', 'generate', 'output_compression', (parameter) => { parameter.minimum = 101; }],
    ['wrong string default type', 'generate', 'quality', (parameter) => { parameter.default = 7; }],
    ['wrong enum member type', 'generate', 'quality', (parameter) => { parameter.enum = ['high', 7]; }],
    ['default outside enum', 'generate', 'quality', (parameter) => { parameter.default = 'ultra'; }],
    ['default above maximum', 'generate', 'output_compression', (parameter) => { parameter.default = 101; }],
    ['wrong boolean default type', 'generate', 'overwrite', (parameter) => { parameter.default = 'false'; }],
    ['negative item bound', 'edit', 'images', (parameter) => { parameter.minimum_items = -1; }],
    ['fractional item bound', 'edit', 'images', (parameter) => { parameter.minimum_items = 1.5; }],
    ['reversed item range', 'edit', 'images', (parameter) => { parameter.minimum_items = 2; parameter.maximum_items = 1; }],
    ['wrong array default member type', 'edit', 'images', (parameter) => { parameter.default = ['ok', 7]; }],
    ['non-finite dimension ratio', 'generate', 'size', (parameter) => {
      parameter.accepted_forms.one_of[1].dimensions.max_long_to_short_ratio = Number.POSITIVE_INFINITY;
    }],
    ['reversed dimension edge range', 'generate', 'size', (parameter) => {
      parameter.accepted_forms.one_of[1].dimensions.min_edge_px = 4096;
    }],
    ['duplicate literal form', 'generate', 'size', (parameter) => {
      parameter.accepted_forms.one_of[0].literals = ['auto', 'auto'];
    }],
    ['compatibility-only public field', 'generate', 'quality', (parameter) => { parameter.effect = 'compatibility_only'; }]
  ];

  for (const [name, action, parameterName, mutate] of cases) {
    const payload = capabilityFixture();
    const parameters = payload.image_mcp.models[0].actions[action].execution_profiles[0].parameters;
    const parameter = parameters.find((item) => item.name === parameterName);
    mutate(parameter);
    assert.throws(
      () => normalizeImageCapabilities(payload),
      (error) => error.code === 'capability_response_invalid',
      name
    );
  }
});

test('get_capabilities summary exposes group, revision, actions, parameters, cache age, and queue limits only', () => {
  const capabilities = normalizeImageCapabilities(capabilityFixture());
  const summary = summarizeImageCapabilities(capabilities, { cacheAgeMS: 321 });
  assert.equal(summary.ok, true);
  assert.equal(summary.enabled, true);
  assert.equal(summary.group.name, 'Codex 图片');
  assert.equal(summary.revision, 'revision-a');
  assert.equal(summary.cache_age_ms, 321);
  assert.equal(summary.max_concurrent_jobs, 2);
  assert.equal(summary.models[0].actions.generate.profiles[0].parameters[0].name, 'prompt');
  assert.equal(normalizeCapabilityRequest({
    model: 'gpt-image-2', action: 'generate', prompt: '复用 get_capabilities 结果'
  }, summary).profile_id, 'profile-a');
  assert.equal(JSON.stringify(summary).includes('synthetic-key'), false);
});

test('MCP tools/list and get_capabilities consume the dedicated Key-scoped contract', async () => {
  const calls = [];
  const deps = {
    env: { GPTEAM_API_KEY: 'synthetic-key-a', GPTEAM_BASE_URL: 'https://api.example.test/v1' },
    capabilityCache: createCapabilityCache(),
    fetch: async (url) => {
      calls.push(String(url));
      return jsonResponse(capabilityFixture());
    }
  };
  const tools = await listImageTools(deps);
  const create = tools.find((tool) => tool.name === 'create_image_job');
  assert.equal(create.inputSchema.oneOf[0].required.includes('model'), true);
  const result = await callImageTool('get_capabilities', {}, deps);
  assert.equal(result.revision, 'revision-a');
  assert.deepEqual(result.models.map((model) => model.id), ['gpt-image-2']);
  assert.equal(calls.length, 1, 'tools/list and get_capabilities share the Key-isolated cache');
});

test('queued jobs freeze contract identity and reject a revision change before upstream dispatch', async () => {
  let discoveryCalls = 0;
  let imageCalls = 0;
  const store = createImageJobStore();
  const deps = {
    store,
    env: { GPTEAM_API_KEY: 'synthetic-key-a', GPTEAM_BASE_URL: 'https://api.example.test/v1' },
    capabilityCache: createCapabilityCache(),
    fetch: async (url) => {
      if (String(url).endsWith('/gpteam/image-capabilities')) {
        discoveryCalls += 1;
        return jsonResponse(capabilityFixture({ revision: discoveryCalls === 1 ? 'revision-a' : 'revision-b' }));
      }
      imageCalls += 1;
      throw new Error('upstream must not be called');
    }
  };
  const created = await callImageTool('create_image_job', {
    model: 'gpt-image-2', action: 'generate', prompt: '画一只猫', idempotency_key: 'frozen-job'
  }, deps);
  const status = await waitForStatus(store, created.job_id, 'failed');
  assert.equal(status.model, 'gpt-image-2');
  assert.equal(status.action, 'generate');
  assert.equal(status.capability_revision, 'revision-a');
  assert.equal(status.error.code, 'stale_capability');
  assert.equal(imageCalls, 0);
});

test('queued jobs fail stale on group, permission, model, profile, or refresh changes', async (context) => {
  const changedModel = capabilityFixture({
    revision: 'revision-b',
    image_mcp: imageMCPFixture({
      default_models: { generate: 'future-image', edit: 'future-image' },
      models: [modelFixture({ id: 'future-image' })]
    })
  });
  const changedProfile = capabilityFixture({ revision: 'revision-b' });
  changedProfile.image_mcp.models[0].actions.generate.execution_profiles[0].id = 'profile-b';
  const cases = [
    ['group switch', capabilityFixture({ revision: 'revision-b', group: { id: 8, name: '另一个分组', platform: 'openai' } })],
    ['permission revoked', capabilityFixture({ revision: 'revision-b', image_mcp: disabledImageMCP() })],
    ['model removed', changedModel],
    ['profile changed', changedProfile],
    ['refresh failed', new TypeError('capability network down')]
  ];
  for (const [name, fresh] of cases) {
    await context.test(name, async () => {
      let discoveryCalls = 0;
      let imageCalls = 0;
      const store = createImageJobStore();
      const deps = {
        store,
        env: { GPTEAM_API_KEY: 'synthetic-key-a', GPTEAM_BASE_URL: 'https://api.example.test/v1' },
        capabilityCache: createCapabilityCache(),
        fetch: async (url) => {
          if (String(url).endsWith('/gpteam/image-capabilities')) {
            discoveryCalls += 1;
            if (discoveryCalls === 1) return jsonResponse(capabilityFixture());
            if (fresh instanceof Error) throw fresh;
            return jsonResponse(fresh);
          }
          imageCalls += 1;
          throw new Error('upstream must not be called');
        }
      };
      const created = await callImageTool('create_image_job', {
        model: 'gpt-image-2', action: 'generate', prompt: '画一只猫'
      }, deps);
      const status = await waitForStatus(store, created.job_id, 'failed');
      assert.equal(status.error.code, 'stale_capability');
      assert.equal(imageCalls, 0);
    });
  }
});

test('cached tool schemas cannot bypass runtime validation and dynamic dispatch never replays a paid request', async () => {
  let imageCalls = 0;
  const store = createImageJobStore();
  const deps = {
    store,
    env: { GPTEAM_API_KEY: 'synthetic-key-a', GPTEAM_BASE_URL: 'https://api.example.test/v1' },
    capabilityCache: createCapabilityCache(),
    fetch: async (url) => {
      if (String(url).endsWith('/gpteam/image-capabilities')) return jsonResponse(capabilityFixture());
      imageCalls += 1;
      throw new TypeError('ambiguous disconnect after dispatch');
    }
  };
  const rejected = await callImageTool('create_image_job', {
    model: 'gpt-image-2', action: 'generate', prompt: '画一只猫', unexpected: true
  }, deps);
  assert.equal(rejected.error.code, 'unsupported_parameter');
  assert.equal(store.jobs.size, 0);

  const created = await callImageTool('create_image_job', {
    model: 'gpt-image-2', action: 'generate', prompt: '画一只猫'
  }, deps);
  const status = await waitForStatus(store, created.job_id, 'failed');
  assert.equal(status.error.code, 'network_error');
  assert.equal(imageCalls, 1, 'possibly accepted dynamic requests are never replayed');
});

function capabilityFixture(overrides = {}) {
  const base = {
    object: 'gpteam.image_capabilities',
    schema_version: 1,
    revision: 'revision-a',
    observed_at: '2026-07-15T12:00:00Z',
    api_key: { id: 51 },
    group: { id: 7, name: 'Codex 图片', platform: 'openai' },
    image_mcp: imageMCPFixture()
  };
  return { ...base, ...overrides };
}

function imageMCPFixture(overrides = {}) {
  return {
    enabled: true,
    blocking_reasons: [],
    default_models: { generate: 'gpt-image-2', edit: 'gpt-image-2' },
    tools: ['create_image_job', 'get_image_job_status', 'download_image_result', 'cancel_image_job', 'get_capabilities'],
    max_concurrent_jobs: 2,
    max_queued_jobs: 20,
    models: [modelFixture()],
    ...overrides
  };
}

function disabledImageMCP() {
  return {
    enabled: false,
    blocking_reasons: ['insufficient_quota'],
    default_models: {},
    tools: ['create_image_job', 'get_image_job_status', 'download_image_result', 'cancel_image_job', 'get_capabilities'],
    max_concurrent_jobs: 2,
    max_queued_jobs: 20,
    models: []
  };
}

function modelFixture(overrides = {}) {
  const generateParameters = overrides.generateParameters || [
    parameter('prompt', 'string', { required: true }),
    parameter('size', 'string', {
      default: '1024x1024',
      accepted_forms: { one_of: [
        { kind: 'literals', literals: ['auto', '1k', '2k', '4k'] },
        { kind: 'dimensions', dimensions: {
          syntax: 'width_x_height', min_edge_px: 1, max_edge_px: 3840,
          edge_multiple_px: 16, min_total_pixels: 655360,
          max_total_pixels: 8294400, max_long_to_short_ratio: 3
        } }
      ] }
    }),
    parameter('quality', 'string', { enum: ['low', 'medium', 'high', 'auto'], default: 'high' }),
    parameter('aspect_ratio', 'string', { enum: ['auto', '1:1', '16:9'], default: 'auto' }),
    parameter('output_compression', 'integer', { minimum: 0, maximum: 100 }),
    parameter('output_path', 'string', { ownership: 'mcp_local', effect: 'gpteam_effective' }),
    parameter('overwrite', 'boolean', { default: false, ownership: 'mcp_local', effect: 'gpteam_effective' }),
    parameter('idempotency_key', 'string', { ownership: 'mcp_local', effect: 'gpteam_effective' })
  ];
  const editParameters = overrides.editParameters || [
    ...generateParameters,
    parameter('images', 'string_array', { required: true, minimum_items: 1 }),
    parameter('mask', 'string')
  ];
  return {
    id: overrides.id || 'gpt-image-2',
    platform: overrides.platform || 'openai',
    aliases: [],
    contract_revision: 1,
    eligible: true,
    routable_by_contract: true,
    actions: {
      generate: actionFixture('/v1/images/generations', generateParameters),
      edit: actionFixture('/v1/images/edits', editParameters)
    }
  };
}

function actionFixture(endpoint, parameters) {
  return {
    endpoint,
    eligible: true,
    execution_profiles: [{
      id: 'profile-a', default_priority: 1, provenance: 'verified_builtin', eligible: true, parameters
    }]
  };
}

function parameter(name, type, overrides = {}) {
  return {
    name,
    description: `${name} description`,
    type,
    required: false,
    ownership: 'forwarded',
    effect: 'upstream_effective',
    ...overrides
  };
}

function jsonResponse(payload, headerValues = {}) {
  return {
    ok: true,
    status: 200,
    headers: headers({ 'content-type': 'application/json', ...headerValues }),
    json: async () => payload,
    text: async () => JSON.stringify(payload)
  };
}

function headers(values = {}) {
  const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => normalized[String(name).toLowerCase()] || null };
}

async function waitForStatus(store, jobID, expected) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const status = getImageJobStatus({ job_id: jobID }, { store });
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getImageJobStatus({ job_id: jobID }, { store });
}
