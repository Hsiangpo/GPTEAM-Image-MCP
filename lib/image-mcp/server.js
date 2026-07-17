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
  const server = new Server({
    name: 'gpteam-image-mcp',
    version: resolvePackageVersion(deps)
  }, {
    capabilities: {
      tools: {}
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listImageTools(deps) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callImageTool(request.params && request.params.name, request.params && request.params.arguments, deps);
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
      return summarizeImageCapabilities(await resolveImageCapabilities(deps));
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
  return buildDynamicImageTools(await resolveImageCapabilities(deps), {
    supportsOneOf: deps.supportsOneOf !== false
  });
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
  return fetchImageCapabilities(credentials, {
    cache: deps.capabilityCache,
    fetch: deps.capabilityFetch || deps.fetch,
    timeoutMS: deps.capabilityTimeoutMS,
    forceRefresh
  });
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
