import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  buildImageGenerationPayload,
  cancelImageJob,
  createImageJob,
  createImageJobStore,
  downloadImageResult,
  generateImage,
  getCapabilities,
  getImageJobStatus,
  loadGPTeamCredentials,
  normalizeBaseUrl,
  parseGPTeamBaseUrl,
  resultFromError,
  structuredToolResult,
  toolResultContent,
  validateImageInput
} from '../lib/image-mcp/image.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { callImageTool, createServer, resolvePackageVersion } from '../lib/image-mcp/server.js';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lAQcIgAAAABJRU5ErkJggg==',
  'base64'
);

test('buildImageGenerationPayload defaults to gpt-image-2 b64 output', () => {
  assert.deepEqual(buildImageGenerationPayload({ prompt: '画一只猫' }), {
    model: 'gpt-image-2',
    prompt: '画一只猫',
    response_format: 'b64_json',
    stream: true,
    size: '1024x1024',
    quality: 'high',
    output_format: 'png'
  });
});

test('buildImageGenerationPayload prefers explicit output_format consistently', () => {
  assert.equal(buildImageGenerationPayload({
    prompt: '画一只猫',
    format: 'png',
    output_format: 'webp'
  }).output_format, 'webp');
});

test('loadGPTeamCredentials reads MCP environment key and base url', () => {
  const credentials = loadGPTeamCredentials({
    env: {
      GPTEAM_API_KEY: 'sk-from-mcp-env',
      GPTEAM_BASE_URL: 'https://api-jp.gpteamservices.com'
    },
    home: os.homedir()
  });

  assert.equal(credentials.apiKey, 'sk-from-mcp-env');
  assert.equal(credentials.baseUrl, 'https://api-jp.gpteamservices.com/v1');
});

test('loadGPTeamCredentials fails closed when no key exists', () => {
  assert.throws(
    () => loadGPTeamCredentials({ env: {}, readFile: () => '{}' }),
    /没有找到 GPTeam API key/
  );
});

test('loadGPTeamCredentials never reads Codex auth as an MCP key source', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  fs.writeFileSync(path.join(tmp, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-official' }), 'utf8');
  fs.writeFileSync(path.join(tmp, 'config.toml'), '[model_providers.gpteam]\nbase_url = "https://api.gpteamservices.com"\n', 'utf8');

  assert.throws(
    () => loadGPTeamCredentials({ env: { GPTEAM_CODEX_HOME: tmp }, home: os.homedir() }),
    /没有找到 GPTeam API key/
  );
});

test('loadGPTeamCredentials does not use inherited OPENAI_API_KEY as the MCP key', () => {
  assert.throws(
    () => loadGPTeamCredentials({
      env: {
        OPENAI_API_KEY: 'sk-official-openai'
      },
      readFile: () => ''
    }),
    /没有找到 GPTeam API key/
  );
});

test('parseGPTeamBaseUrl only reads model_providers.gpteam base_url', () => {
  const config = [
    '[mcp_servers.local]',
    'base_url = "http://localhost:8080"',
    '',
    '[model_providers.other]',
    'base_url = "https://other.example/v1"',
    '',
    '[model_providers.gpteam]',
    'base_url = "https://api.gpteamservices.com"',
    ''
  ].join('\n');

  assert.equal(parseGPTeamBaseUrl(config), 'https://api.gpteamservices.com');
});

test('normalizeBaseUrl removes trailing slashes and appends v1 when needed', () => {
  assert.equal(normalizeBaseUrl('https://api.gpteamservices.com/v1/'), 'https://api.gpteamservices.com/v1');
  assert.equal(normalizeBaseUrl('https://api.gpteamservices.com'), 'https://api.gpteamservices.com/v1');
});

test('generateImage calls GPTeam images endpoint and saves returned base64 image', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const calls = [];
  const result = await generateImage({
    prompt: '中国90年代一家三口在家里拍的照片',
    output_path: path.join(tmp, 'family.png')
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test'
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [{
            b64_json: PNG_1X1.toString('base64'),
            revised_prompt: 'revised'
          }]
        })
      };
    }
  });

  assert.equal(calls[0].url, 'https://api.example.test/v1/images/generations');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(calls[0].options.body).model, 'gpt-image-2');
  assert.equal(JSON.parse(calls[0].options.body).stream, true);
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'family.png')), PNG_1X1);
  assert.equal(result.path, path.join(tmp, 'family.png'));
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.revisedPrompt, 'revised');
});

test('generateImage reads streaming image events to avoid idle response gaps', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const result = await generateImage({
    prompt: '画一只猫',
    output_path: path.join(tmp, 'streamed.png')
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async () => imageStreamFetchResponse([
      { type: 'image_generation.started', created_at: 1710000000 },
      {
        type: 'image_generation.completed',
        b64_json: PNG_1X1.toString('base64'),
        revised_prompt: 'stream revised'
      }
    ])
  });

  assert.equal(result.revised_prompt, 'stream revised');
  assert.deepEqual(fs.readFileSync(path.join(tmp, 'streamed.png')), PNG_1X1);
});

test('generateImage supports Image 2 edit inputs from local files and masks', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const inputPath = path.join(tmp, 'input.png');
  fs.writeFileSync(inputPath, PNG_1X1);
  const calls = [];

  await generateImage({
    prompt: '把照片改成90年代胶片风格',
    images: [inputPath],
    mask: `data:image/png;base64,${PNG_1X1.toString('base64')}`,
    input_fidelity: 'high',
    output_path: path.join(tmp, 'edited.png')
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return imageFetchResponse({ b64_json: PNG_1X1.toString('base64') });
    }
  });

  assert.equal(calls[0].url, 'https://api.example.test/v1/images/edits');
  assert.match(calls[0].body.images[0].image_url, /^data:image\/png;base64,/);
  assert.match(calls[0].body.mask.image_url, /^data:image\/png;base64,/);
  assert.equal(calls[0].body.input_fidelity, undefined);
});

test('generateImage accepts common image-to-image alias fields', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const imagePath = path.join(tmp, 'input.png');
  const maskPath = path.join(tmp, 'mask.png');
  fs.writeFileSync(imagePath, PNG_1X1);
  fs.writeFileSync(maskPath, PNG_1X1);
  const calls = [];

  await generateImage({
    prompt: '把输入图改成电影海报',
    image_path: imagePath,
    input_images: [`data:image/png;base64,${PNG_1X1.toString('base64')}`],
    mask_path: maskPath,
    output_path: path.join(tmp, 'poster.png')
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return imageFetchResponse({ b64_json: PNG_1X1.toString('base64') });
    }
  });

  assert.equal(calls[0].url, 'https://api.example.test/v1/images/edits');
  assert.equal(calls[0].body.images.length, 2);
  assert.match(calls[0].body.images[0].image_url, /^data:image\/png;base64,/);
  assert.match(calls[0].body.images[1].image_url, /^data:image\/png;base64,/);
  assert.match(calls[0].body.mask.image_url, /^data:image\/png;base64,/);
});

test('generateImage returns structured metadata and does not overwrite existing files', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const originalPath = path.join(tmp, 'family.png');
  fs.writeFileSync(originalPath, 'old-file', 'utf8');

  const result = await generateImage({
    prompt: '生成一张中国90年代一家三口在家里拍的照片',
    output_path: originalPath,
    include_revised_prompt: false
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async () => imageFetchResponse({
      b64_json: PNG_1X1.toString('base64'),
      revised_prompt: 'upstream rewrite'
    })
  });

  const expectedPath = path.join(tmp, 'family-v2.png');
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'old-file');
  assert.deepEqual(fs.readFileSync(expectedPath), PNG_1X1);
  assert.equal(result.ok, true);
  assert.equal(result.file, expectedPath);
  assert.equal(result.final_file, expectedPath);
  assert.equal(result.path, expectedPath);
  assert.equal(result.bytes, PNG_1X1.length);
  assert.equal(result.sha256, crypto.createHash('sha256').update(PNG_1X1).digest('hex'));
  assert.equal(result.mime_type, 'image/png');
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.revised_prompt, undefined);
  assert.match(result.job_id, /^img_/);
  assert.match(result.trace_id, /^tr_/);
  assert.equal(typeof result.duration_ms, 'number');
});

test('generateImage can overwrite an explicit output path when requested', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const outputPath = path.join(tmp, 'family.png');
  fs.writeFileSync(outputPath, 'old-file', 'utf8');

  const result = await generateImage({
    prompt: '生成一张复古家庭照',
    output_path: outputPath,
    overwrite: true
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async () => imageFetchResponse({ b64_json: PNG_1X1.toString('base64') })
  });

  assert.equal(result.file, outputPath);
  assert.deepEqual(fs.readFileSync(outputPath), PNG_1X1);
});

test('generateImage retries retryable failures and classifies the final result', async () => {
  let attempts = 0;
  const result = await generateImage({ prompt: '画一只猫' }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1',
      GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
    },
    retryDelayMs: 0,
    fetch: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT', hostname: 'api.example.test' } });
      }
      if (attempts === 2) {
        return {
          ok: false,
          status: 502,
          text: async () => 'temporary bad gateway'
        };
      }
      return imageFetchResponse({ b64_json: PNG_1X1.toString('base64') });
    }
  });

  assert.equal(attempts, 3);
  assert.equal(result.ok, true);
  assert.equal(result.retry_count, 2);
});

test('generateImage falls back to default attempts when retry env is misconfigured to zero', async () => {
  let attempts = 0;
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, {
      env: {
        GPTEAM_API_KEY: 'sk-test',
        GPTEAM_BASE_URL: 'https://api.example.test/v1',
        GPTEAM_IMAGE_MAX_ATTEMPTS: '0',
        GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
      },
      retryDelayMs: 0,
      fetch: async () => {
        attempts += 1;
        throw new TypeError('fetch failed', { cause: { code: 'ETIMEDOUT', hostname: 'api.example.test' } });
      }
    }),
    (error) => {
      assert.equal(error.code, 'network_timeout');
      return true;
    }
  );
  assert.equal(attempts, 3);
});

test('generateImage keeps request timeout active while reading the response body', async () => {
  await assert.rejects(
    generateImage({ prompt: '画一只猫' }, {
      env: {
        GPTEAM_API_KEY: 'sk-test',
        GPTEAM_BASE_URL: 'https://api.example.test/v1',
        GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
      },
      maxAttempts: 1,
      requestTimeoutMs: 5,
      fetch: async (_url, options) => ({
        ok: true,
        status: 200,
        json: async () => new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('body read aborted')), { once: true });
        })
      })
    }),
    (error) => {
      assert.equal(error.code, 'network_timeout');
      const serialized = resultFromError(error, { trace_id: 'tr_test' }).error;
      assert.equal(serialized.code, 'network_timeout');
      assert.equal(serialized.stage, 'network');
      assert.equal(serialized.trace_id, 'tr_test');
      return true;
    }
  );
});

test('generateImage saves with the actual image extension when upstream ignores requested format', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const result = await generateImage({
    prompt: '生成一张复古家庭照',
    output_path: path.join(tmp, 'family.jpeg'),
    format: 'jpeg'
  }, {
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async () => imageFetchResponse({ b64_json: PNG_1X1.toString('base64') })
  });

  assert.equal(result.file, path.join(tmp, 'family.png'));
  assert.equal(result.format, 'png');
  assert.equal(result.mime_type, 'image/png');
  assert.ok(fs.existsSync(path.join(tmp, 'family.png')));
  assert.equal(fs.existsSync(path.join(tmp, 'family.jpeg')), false);
});

test('generateImage retries a non-overwrite path when another process wins the final write race', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  const originalLinkSync = fs.linkSync;
  let conflictInjected = false;
  fs.linkSync = (existingPath, newPath) => {
    if (!conflictInjected && newPath.endsWith('family.png')) {
      conflictInjected = true;
      fs.writeFileSync(newPath, 'other-process-file', 'utf8');
      const error = new Error('file exists');
      error.code = 'EEXIST';
      throw error;
    }
    return originalLinkSync(existingPath, newPath);
  };
  try {
    const result = await generateImage({
      prompt: '生成一张复古家庭照',
      output_path: path.join(tmp, 'family.png')
    }, {
      env: {
        GPTEAM_API_KEY: 'sk-test',
        GPTEAM_BASE_URL: 'https://api.example.test/v1'
      },
      fetch: async () => imageFetchResponse({ b64_json: PNG_1X1.toString('base64') })
    });

    assert.equal(result.file, path.join(tmp, 'family-v2.png'));
    assert.equal(fs.readFileSync(path.join(tmp, 'family.png'), 'utf8'), 'other-process-file');
    assert.deepEqual(fs.readFileSync(path.join(tmp, 'family-v2.png')), PNG_1X1);
  } finally {
    fs.linkSync = originalLinkSync;
  }
});

test('createImageJob runs image generation in the local MCP background and download returns result JSON', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'));
  let resolveFetch;
  const fetchPromise = new Promise((resolve) => {
    resolveFetch = resolve;
  });
  const store = createImageJobStore({ now: () => Date.now() });
  const created = createImageJob({
    prompt: '生成一张复古家庭照',
    output_path: path.join(tmp, 'family.png')
  }, {
    store,
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1'
    },
    fetch: async () => fetchPromise
  });

  assert.equal(created.ok, true);
  assert.match(created.job_id, /^img_/);
  const pending = getImageJobStatus({ job_id: created.job_id }, { store });
  assert.match(pending.status, /queued|running/);

  resolveFetch(imageFetchResponse({ b64_json: PNG_1X1.toString('base64'), revised_prompt: 'revised' }));
  const finalStatus = await waitForJobStatus(store, created.job_id, 'succeeded');
  assert.equal(finalStatus.ok, true);
  assert.equal(finalStatus.status, 'succeeded');

  const downloaded = downloadImageResult({ job_id: created.job_id }, { store });
  assert.equal(downloaded.ok, true);
  assert.equal(downloaded.status, 'succeeded');
  assert.equal(downloaded.file, path.join(tmp, 'family.png'));
  assert.equal(downloaded.bytes, PNG_1X1.length);
  assert.equal(downloaded.b64, undefined);
  assert.equal(downloaded.mimeType, undefined);

  const withImage = downloadImageResult({ job_id: created.job_id, include_image: true }, { store });
  assert.equal(withImage.b64, PNG_1X1.toString('base64'));
  assert.equal(withImage.mimeType, 'image/png');
});

test('cancelImageJob aborts a running local image job', async () => {
  const store = createImageJobStore();
  let capturedSignal;
  const created = createImageJob({ prompt: '画一只猫' }, {
    store,
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1',
      GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
    },
    fetch: async (_url, options) => {
      capturedSignal = options.signal;
      return new Promise(() => {});
    }
  });

  await waitUntil(() => Boolean(capturedSignal));
  const cancelled = cancelImageJob({ job_id: created.job_id }, { store });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.status, 'canceled');
  assert.equal(cancelled.legacy_status, 'cancelled');
  assert.equal(cancelled.cancellation_mode, 'best_effort');
  assert.equal(capturedSignal.aborted, true);
});

test('createImageJob reuses idempotency_key and enforces local queue limits', async () => {
  const store = createImageJobStore({ maxConcurrent: 1, maxQueue: 1 });
  let resolveFirst;
  const firstFetch = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  const options = {
    store,
    maxConcurrent: 1,
    maxQueue: 1,
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1',
      GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
    },
    fetch: async () => firstFetch
  };

  const first = createImageJob({ prompt: '画一只猫', idempotency_key: 'same-key' }, options);
  const duplicate = createImageJob({ prompt: '画一只猫', idempotency_key: 'same-key' }, options);
  const second = createImageJob({ prompt: '画一只狗' }, options);
  const third = createImageJob({ prompt: '画一只鸟' }, options);

  assert.equal(duplicate.job_id, first.job_id);
  assert.equal(second.status, 'queued');
  assert.equal(third.ok, false);
  assert.equal(third.error.code, 'queue_full');
  assert.equal(third.error.retryable, true);

  resolveFirst(imageFetchResponse({ b64_json: PNG_1X1.toString('base64') }));
  await waitForJobStatus(store, first.job_id, 'succeeded');
  cancelImageJob({ job_id: second.job_id }, { store });
});

test('getCapabilities reports async image edit support and queue limits', () => {
  const caps = getCapabilities({
    env: {
      GPTEAM_IMAGE_MAX_CONCURRENT: '3',
      GPTEAM_IMAGE_MAX_QUEUE: '9'
    }
  });

  assert.equal(caps.ok, true);
  assert.equal(caps.default_model, 'gpt-image-2');
  assert.equal(caps.supports_async, true);
  assert.equal(caps.supports_image_to_image, true);
  assert.deepEqual(caps.image_input_fields, ['images', 'image', 'image_path', 'image_paths', 'input_image', 'input_images']);
  assert.deepEqual(caps.mask_input_fields, ['mask', 'mask_path']);
  assert.equal(caps.supports_custom_size, true);
  assert.deepEqual(caps.size_presets, ['1K', '2K', '4K', 'auto']);
  assert.ok(caps.sizes.includes('3840x2160'));
  assert.ok(caps.sizes.includes('2160x3840'));
  assert.ok(caps.aspect_ratios.includes('9:16'));
  assert.deepEqual(caps.formats, ['png', 'jpeg', 'webp']);
  assert.deepEqual(caps.quality, ['low', 'medium', 'high', 'auto']);
  assert.deepEqual(caps.statuses, ['queued', 'running', 'succeeded', 'failed', 'canceled', 'expired']);
  assert.equal(caps.preferred_tool, 'create_image_job');
  assert.equal(caps.default_request_timeout_ms, 15 * 60 * 1000);
  assert.equal(caps.max_concurrent_jobs, 3);
  assert.equal(caps.max_queued_jobs, 9);
});

test('validateImageInput rejects invalid image parameters locally', () => {
  assert.throws(
    () => validateImageInput({ prompt: '画图', size: '4097x1024' }, { requirePrompt: true }),
    (error) => error.code === 'invalid_size' && error.details.field === 'size'
  );
  assert.throws(
    () => validateImageInput({ prompt: '画图', quality: 'ultra' }, { requirePrompt: true }),
    (error) => error.code === 'invalid_quality' && error.details.field === 'quality'
  );
  assert.throws(
    () => validateImageInput({ prompt: '画图', format: 'gif' }, { requirePrompt: true }),
    (error) => error.code === 'invalid_format' && error.details.field === 'format'
  );
  assert.throws(
    () => validateImageInput({ prompt: '画图', format: 'png', output_format: 'webp' }, { requirePrompt: true }),
    (error) => error.code === 'invalid_format_conflict' && error.details.field === 'output_format'
  );
  assert.doesNotThrow(() => validateImageInput({
    prompt: '画图',
    size: '2160x3840',
    quality: 'high',
    format: 'jpg',
    background: 'opaque',
    moderation: 'auto',
    output_compression: 80
  }, { requirePrompt: true }));
});

test('generateImage rejects invalid parameters before calling upstream', async () => {
  let fetchCalled = false;
  await assert.rejects(
    generateImage({ prompt: '画图', output_format: 'bmp' }, {
      env: {
        GPTEAM_API_KEY: 'sk-test',
        GPTEAM_BASE_URL: 'https://api.example.test/v1'
      },
      fetch: async () => {
        fetchCalled = true;
        return imageFetchResponse({ b64_json: PNG_1X1.toString('base64') });
      }
    }),
    (error) => error.code === 'invalid_format' && error.retryable === false
  );
  assert.equal(fetchCalled, false);
});

test('createImageJob returns structured validation error without queueing invalid tasks', () => {
  const store = createImageJobStore();
  const result = createImageJob({ prompt: '画图', size: '100x100' }, { store });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_size');
  assert.equal(result.error.stage, 'validate');
  assert.equal(store.jobs.size, 0);
});

test('cleanup does not remove running jobs while a long image fetch is still alive', async () => {
  let fakeNow = Date.now();
  const store = createImageJobStore({ now: () => fakeNow, ttlMs: 1 });
  const created = createImageJob({ prompt: '画一只猫' }, {
    store,
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1',
      GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
    },
    fetch: async () => new Promise(() => {})
  });

  await waitUntil(() => getImageJobStatus({ job_id: created.job_id }, { store }).status === 'running');
  fakeNow += 60 * 60 * 1000;
  const status = getImageJobStatus({ job_id: created.job_id }, { store });
  assert.equal(status.status, 'running');
  cancelImageJob({ job_id: created.job_id }, { store });
});

test('toolResultContent returns stable JSON text without embedding base64 in structured content', () => {
  const result = {
    ok: true,
    file: '/tmp/family.png',
    model: 'gpt-image-2',
    size: '1024x1024',
    format: 'png',
    quality: 'high',
    bytes: 123,
    sha256: 'abc',
    duration_ms: 456,
    job_id: 'img_test',
    trace_id: 'tr_test',
    b64: PNG_1X1.toString('base64'),
    mimeType: 'image/png'
  };

  const structured = structuredToolResult(result);
  assert.equal(structured.ok, true);
  assert.equal(structured.file, '/tmp/family.png');
  assert.equal(structured.b64, undefined);

  const content = toolResultContent(result);
  assert.equal(content[0].type, 'text');
  assert.deepEqual(JSON.parse(content[0].text), structured);
  assert.equal(content[1].type, 'image');
});

test('generateImage surfaces upstream error text without leaking bearer token', async () => {
  await assert.rejects(
    generateImage({ prompt: '画图' }, {
      env: {
        GPTEAM_API_KEY: 'sk-secret',
        GPTEAM_BASE_URL: 'https://api.example.test/v1'
      },
      retryDelayMs: 0,
      fetch: async () => ({
        ok: false,
        status: 429,
        text: async () => 'rate limit for account sk-secret'
      })
    }),
    (error) => {
      assert.match(error.message, /HTTP 429/);
      assert.doesNotMatch(error.message, /sk-secret/);
      return true;
    }
  );
});

test('createServer constructs MCP stdio server object', () => {
  const server = createServer();
  assert.equal(typeof server.connect, 'function');
});

test('callImageTool throws a protocol error for unknown tools', async () => {
  await assert.rejects(
    callImageTool('unknown_tool', {}),
    (error) => {
      assert.ok(error instanceof McpError);
      assert.equal(error.code, ErrorCode.InvalidParams);
      return true;
    }
  );
});

test('callImageTool exposes get_capabilities', async () => {
  const result = await callImageTool('get_capabilities', {}, {});
  assert.equal(result.ok, true);
  assert.equal(result.supports_cancel, true);
});

test('callImageTool maps legacy generate_image to async job to avoid MCP disconnects', async () => {
  const store = createImageJobStore({ maxConcurrent: 1, maxQueue: 1 });
  const result = await callImageTool('generate_image', { prompt: '画一只猫' }, {
    store,
    env: {
      GPTEAM_API_KEY: 'sk-test',
      GPTEAM_BASE_URL: 'https://api.example.test/v1',
      GPTEAM_IMAGE_OUTPUT_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'gpteam-image-mcp-'))
    },
    fetch: async () => new Promise(() => {})
  });

  assert.equal(result.ok, true);
  assert.match(result.job_id, /^img_/);
  assert.match(result.status, /queued|running/);
});

test('resolvePackageVersion reads the npm package version for MCP serverInfo', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(resolvePackageVersion(), pkg.version);
});

function imageFetchResponse(item) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [item] })
  };
}

function imageStreamFetchResponse(items) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => String(name).toLowerCase() === 'content-type' ? 'text/event-stream' : '' },
    text: async () => items.map((item) => `data: ${JSON.stringify(item)}\n\n`).join('') + 'data: [DONE]\n\n'
  };
}

async function waitForJobStatus(store, jobID, expectedStatus) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const status = getImageJobStatus({ job_id: jobID }, { store });
    if (status.status === expectedStatus) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getImageJobStatus({ job_id: jobID }, { store });
}

async function waitUntil(condition) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
