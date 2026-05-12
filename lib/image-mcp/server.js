import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import {
  cancelImageJob,
  createImageJob,
  downloadImageResult,
  getCapabilities,
  IMAGE_BACKGROUND_OPTIONS,
  IMAGE_FORMATS,
  IMAGE_MODERATION_OPTIONS,
  IMAGE_QUALITY_LEVELS,
  POPULAR_IMAGE_SIZES,
  getImageJobStatus,
  resultFromError,
  structuredToolResult,
  toolResultContent
} from './image.js';

const imageToolPromptingInstruction = '调用前请先确认用户真实需求：尺寸或比例、质量、输出格式、保存目录或文件名。缺少这些关键信息时应先追问，不要直接默认生成。常规生图请优先用 create_image_job，避免长任务占住 MCP 连接。';

const imageInputProperties = {
  prompt: {
    type: 'string',
    description: '图片提示词。需要尽量具体，若用户只给模糊需求，应先追问风格、主体、场景和用途。'
  },
  size: {
    type: 'string',
    description: `图片尺寸。支持 auto、常用尺寸 ${POPULAR_IMAGE_SIZES.map((item) => `${item.label} ${item.size}`).join('、')}，也支持满足约束的自定义宽高，例如 9:16 可用 1152x2048 或 2160x3840。`
  },
  quality: {
    type: 'string',
    description: '图片质量。生图前应让用户确认速度优先还是质量优先。',
    enum: IMAGE_QUALITY_LEVELS
  },
  format: {
    type: 'string',
    description: '输出图片格式。',
    enum: IMAGE_FORMATS
  },
  output_format: {
    type: 'string',
    description: '输出图片格式别名，和 format 等价。',
    enum: IMAGE_FORMATS
  },
  output_path: {
    type: 'string',
    description: '保存路径，可以是目录或完整文件路径。缺少时建议先询问用户想保存到哪里。'
  },
  overwrite: {
    type: 'boolean',
    description: '文件已存在时是否覆盖。默认 false，会自动生成 -v2、-v3 等新文件名。',
    default: false
  },
  idempotency_key: {
    type: 'string',
    description: '幂等键。客户端超时后用同一个 key 重试，会复用同一进程内的本地任务，避免重复生成。'
  },
  image: {
    type: 'string',
    description: '单张输入图片，支持 data URL、HTTPS URL 或本地文件路径，用于图生图或编辑。'
  },
  images: {
    type: 'array',
    items: { type: 'string' },
    description: '多张输入图片，支持 data URL、HTTPS URL 或本地文件路径，用于图生图或编辑。'
  },
  image_path: {
    type: 'string',
    description: '单张本地输入图片路径别名，用于图生图或编辑。'
  },
  image_paths: {
    type: 'array',
    items: { type: 'string' },
    description: '多张本地输入图片路径别名，用于图生图或编辑。'
  },
  input_image: {
    type: 'string',
    description: '单张输入图片别名，支持 data URL、HTTPS URL 或本地文件路径。'
  },
  input_images: {
    type: 'array',
    items: { type: 'string' },
    description: '多张输入图片别名，支持 data URL、HTTPS URL 或本地文件路径。'
  },
  mask: {
    type: 'string',
    description: '编辑遮罩图片，支持 data URL、HTTPS URL 或本地文件路径。'
  },
  mask_path: {
    type: 'string',
    description: '本地遮罩图片路径别名。'
  },
  input_fidelity: {
    type: 'string',
    description: '兼容字段。当前 GPTeam Image 2 桥接会忽略该字段，因为上游 Codex 图片工具会拒绝 edits 中的该参数。',
    enum: ['low', 'high']
  },
  background: {
    type: 'string',
    description: '背景策略。gpt-image-2 当前支持 auto 或 opaque。',
    enum: IMAGE_BACKGROUND_OPTIONS
  },
  moderation: {
    type: 'string',
    description: '内容安全策略。通常保持 auto，需要更低过滤强度时可用 low。',
    enum: IMAGE_MODERATION_OPTIONS
  },
  output_compression: {
    type: 'integer',
    description: '输出压缩比例，0 到 100 的整数。'
  },
  include_revised_prompt: {
    type: 'boolean',
    description: '是否返回上游修订后的提示词。',
    default: true
  },
  return_revised_prompt: {
    type: 'boolean',
    description: '是否返回上游修订后的提示词，兼容旧字段。',
    default: true
  }
};

const tools = [
  {
    name: 'create_image_job',
    description: `推荐常规使用。创建本地后台 GPTeam Image 2 任务并立即返回 job_id。${imageToolPromptingInstruction}`,
    inputSchema: {
      type: 'object',
      properties: imageInputProperties,
      required: ['prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'get_image_job_status',
    description: '查询本地 GPTeam Image 2 图片任务状态。',
    inputSchema: jobIDSchema()
  },
  {
    name: 'cancel_image_job',
    description: '取消仍在 queued 或 running 的本地 GPTeam Image 2 图片任务。取消是 best-effort，上游已开始生成时不保证同步取消。',
    inputSchema: jobIDSchema()
  },
  {
    name: 'download_image_result',
    description: '下载已完成图片任务的本地文件元数据和图片内容，可选择只返回 metadata。',
    inputSchema: downloadSchema()
  },
  {
    name: 'get_capabilities',
    description: '返回 GPTeam Image MCP 能力，包括支持尺寸、格式、质量、异步任务、取消语义、队列上限和参数约束。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: 'generate_image',
    description: `兼容旧调用的异步别名。为避免长图或高质量任务导致 MCP 连接断开，它不会等待图片完成，而是创建任务并立即返回 job_id；之后必须用 get_image_job_status 和 download_image_result 获取结果。${imageToolPromptingInstruction}`,
    inputSchema: {
      type: 'object',
      properties: imageInputProperties,
      required: ['prompt'],
      additionalProperties: false
    }
  }
];

export function createServer(deps = {}) {
  const server = new Server({
    name: 'gpteam-image-mcp',
    version: resolvePackageVersion(deps)
  }, {
    capabilities: {
      tools: {}
    }
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

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
      return createImageJob(args || {}, deps);
    case 'get_image_job_status':
      return getImageJobStatus(args || {}, deps);
    case 'cancel_image_job':
      return cancelImageJob(args || {}, deps);
    case 'download_image_result':
      return downloadImageResult(args || {}, deps);
    case 'get_capabilities':
      return getCapabilities(deps);
    case 'generate_image':
      return createImageJob(args || {}, deps);
    default:
      throw new McpError(ErrorCode.InvalidParams, `未知工具：${toolName}`);
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    return resultFromError(error);
  }
}

function downloadSchema() {
  const schema = jobIDSchema();
  schema.properties.metadata_only = {
    type: 'boolean',
    description: '只返回文件路径和元数据，不返回 MCP 图片内容。默认 true，避免大图进入上下文触发频繁 compact。',
    default: true
  };
  schema.properties.include_image = {
    type: 'boolean',
    description: '显式返回 MCP 图片内容。大图会显著增加上下文，通常保持 false，只使用本地文件路径。',
    default: false
  };
  schema.properties.include_revised_prompt = {
    type: 'boolean',
    description: 'Include revised prompt when available.',
    default: true
  };
  return schema;
}

function jobIDSchema() {
  return {
    type: 'object',
    properties: {
      job_id: {
        type: 'string',
        description: 'Image job id returned by create_image_job.'
      }
    },
    required: ['job_id'],
    additionalProperties: false
  };
}
