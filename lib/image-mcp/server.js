import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import {
  cancelImageJob,
  createImageJob,
  downloadImageResult,
  getImageJobStatus,
  loadGPTEAMCredentials,
  resultFromError,
  structuredToolResult,
  toolResultContent
} from './image.js';
import {
  buildDynamicImageTools,
  fetchImageCapabilities,
  summarizeImageCapabilities
} from './capabilities.js';
import { normalizeCapabilityRequest } from './validation.js';

export function createServer(deps = {}) {
  const protocolServerFactory = deps.protocolServerFactory || ((serverInfo, options) => new Server(serverInfo, options));
  const server = protocolServerFactory({
    name: 'gpteam-image-mcp',
    version: resolvePackageVersion(deps)
  }, {
    capabilities: {
      tools: { listChanged: true }
    }
  });
  const runtimeDeps = {
    ...deps,
    capabilityRevisionState: deps.capabilityRevisionState || { initialized: false, revision: '' },
    notifyToolListChanged: deps.notifyToolListChanged || (() => server.sendToolListChanged())
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listImageTools(runtimeDeps) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callImageTool(
      request.params && request.params.name,
      request.params && request.params.arguments,
      runtimeDeps
    );
    return {
      content: toolResultContent(result),
      structuredContent: structuredToolResult(result),
      isError: result && result.ok === false
    };
  });

  return server;
}

export async function runServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function resolvePackageVersion(deps = {}) {
  const readFile = deps.readFile || ((filePath) => fs.readFileSync(filePath, 'utf8'));
  try {
    const pkg = JSON.parse(readFile(new URL('../../package.json', import.meta.url)));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export async function callImageTool(toolName, args = {}, deps = {}) {
  try {
    switch (toolName) {
    case 'create_image_job':
      return await createDynamicImageJob(args || {}, deps, false);
    case 'get_image_job_status':
      return getImageJobStatus(args || {}, deps);
    case 'cancel_image_job':
      return cancelImageJob(args || {}, deps);
    case 'download_image_result':
      return downloadImageResult(args || {}, deps);
    case 'get_capabilities':
      return summarizeImageCapabilities(await resolveImageCapabilities(deps, true));
    case 'generate_image':
      return await createDynamicImageJob(args || {}, deps, true);
    default:
      throw new McpError(ErrorCode.InvalidParams, `未知工具：${toolName}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    return resultFromError(error);
  }
}

export async function listImageTools(deps = {}) {
  let capabilities;
  try {
    capabilities = await resolveImageCapabilities(deps);
  } catch {
    observeCapabilityUnavailable(deps);
    return buildDynamicImageTools(null);
  }
  return buildDynamicImageTools(capabilities);
}

async function createDynamicImageJob(args, deps, legacyAlias) {
  const capabilities = await resolveImageCapabilities(deps);
  const input = legacyAlias ? legacyAliasInput(args, capabilities) : args;
  const snapshot = normalizeCapabilityRequest(input, capabilities);
  return createImageJob({ model: snapshot.model, action: snapshot.action, ...snapshot.parameters }, {
    ...deps,
    maxConcurrent: capabilities.max_concurrent_jobs,
    maxQueue: capabilities.max_queued_jobs,
    capabilitySnapshot: snapshot,
    revalidateCapabilities: async () => resolveImageCapabilities(deps, true)
  });
}

async function resolveImageCapabilities(deps, forceRefresh = false) {
  const credentials = loadGPTEAMCredentials(deps);
  const capabilities = await fetchImageCapabilities(credentials, {
    cache: deps.capabilityCache,
    fetch: deps.capabilityFetch || deps.fetch,
    env: deps.env,
    timeoutMS: deps.capabilityTimeoutMS,
    forceRefresh
  });
  await observeCapabilityRevision(deps, capabilities.revision);
  return capabilities;
}

async function observeCapabilityRevision(deps, revision) {
  const state = deps.capabilityRevisionState;
  if (!state || !revision) return;
  if (state.initialized !== true) {
    state.initialized = true;
    state.revision = revision;
    return;
  }
  if (state.revision === revision) return;
  if (state.notificationPromise) {
    const pendingRevision = state.notificationRevision;
    await state.notificationPromise;
    if (pendingRevision === revision || state.revision === revision) return;
  }
  if (typeof deps.notifyToolListChanged !== 'function') {
    state.revision = revision;
    return;
  }
  let notification;
  notification = Promise.resolve()
    .then(() => deps.notifyToolListChanged())
    .then(() => {
      state.revision = revision;
    })
    .catch(() => {
      // 通知失败时保留旧 revision，后续刷新会重试通知。
    })
    .finally(() => {
      if (state.notificationPromise !== notification) return;
      state.notificationPromise = null;
      state.notificationRevision = '';
    });
  state.notificationRevision = revision;
  state.notificationPromise = notification;
  await notification;
}

function observeCapabilityUnavailable(deps) {
  const state = deps.capabilityRevisionState;
  if (!state) return;
  state.initialized = true;
  state.revision = '';
}

function legacyAliasInput(args, capabilities) {
  const action = args.action || (hasEditInput(args) ? 'edit' : 'generate');
  return {
    ...args,
    action,
    model: args.model || capabilities.default_models[action]
  };
}

function hasEditInput(args) {
  return ['images', 'image', 'image_path', 'image_paths', 'input_image', 'input_images', 'mask', 'mask_path']
    .some((field) => args && args[field] !== undefined);
}
