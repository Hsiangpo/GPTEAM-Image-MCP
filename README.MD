# GPTEAM Image MCP

GPTEAM Image MCP 是一个面向 MCP 客户端的图片生成与图片编辑服务。它通过 GPTEAM 的 OpenAI 兼容图片接口发起请求，支持文生图、图生图、局部编辑、本地保存、任务查询和取消。

这个 MCP 默认采用异步任务模式：创建任务后先返回 `job_id`，图片生成继续在本地后台执行。这样可以避免高质量图片或长任务导致 MCP 客户端等待过久，出现连接断开或上下文被大图撑爆的问题。

## 能力概览

- `create_image_job`：创建图片任务，推荐常规使用。
- `get_image_job_status`：查询任务状态。
- `download_image_result`：下载任务结果，默认只返回文件路径和元数据。
- `cancel_image_job`：取消排队中或运行中的任务，取消是 best-effort。
- `get_capabilities`：查看支持的尺寸、格式、质量和参数约束。
- `generate_image`：旧调用兼容别名，内部同样会创建异步任务。

默认模型是 `gpt-image-2`，默认 Base URL 写根域名 `https://api.gpteamservices.com`。运行时会自动补 `/v1` 调用图片接口，旧的 `/v1` 配置也继续兼容。

## 环境要求

- Node.js `18.18.0` 或更高版本。
- 一个可用的 GPTeam API Key。
- MCP 客户端，例如 Codex、Claude Desktop 或其他支持 MCP stdio 的客户端。

## MCP 客户端安装

在你的 MCP 配置中加入下面这一段，把 `sk-xxxx` 替换为自己的 GPTeam API Key。

```json
{
  "mcpServers": {
    "gpteam-image": {
      "command": "npx",
      "args": ["-y", "github:Hsiangpo/GPTeam-Image-MCP"],
      "env": {
        "GPTEAM_API_KEY": "sk-xxxx",
        "GPTEAM_BASE_URL": "https://api.gpteamservices.com"
      }
    }
  }
}
```

如果你要指定图片默认保存目录，可以额外加入：

```json
{
  "GPTEAM_IMAGE_OUTPUT_DIR": "/Users/yourname/Pictures/GPTeam"
}
```

## 本地开发运行

```bash
git clone https://github.com/Hsiangpo/GPTeam-Image-MCP.git
cd GPTeam-Image-MCP
npm install
GPTEAM_API_KEY=sk-xxxx npm start
```

运行测试：

```bash
npm test
```

检查实际会打包进 npm 或 GitHub npx 安装面的文件：

```bash
npm pack --dry-run --json
```

## 调用示例

创建图片任务：

```json
{
  "prompt": "一张未来城市夜景海报，霓虹灯，电影感，高细节",
  "size": "2048x1152",
  "quality": "high",
  "output_format": "png",
  "output_path": "~/Pictures/GPTeam"
}
```

查询任务：

```json
{
  "job_id": "img_xxxxx"
}
```

下载结果：

```json
{
  "job_id": "img_xxxxx"
}
```

`download_image_result` 默认只返回本地文件路径、图片尺寸、字节数、哈希和修订提示词，不会把图片 base64 直接塞回 MCP 上下文。只有在客户端必须接收图片内容时，才显式传入：

```json
{
  "job_id": "img_xxxxx",
  "include_image": true
}
```

## 支持的图片参数

- `prompt`：图片提示词，必填。
- `size`：图片尺寸，支持 `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`2048x1152`、`1152x2048`、`3840x2160`、`2160x3840`、`auto`。`2K` 和 `4K` 是正式输出规格，完成结果会返回最终图片宽高。
- `quality`：`low`、`medium`、`high`、`auto`。
- `output_format` 或 `format`：`png`、`jpeg`、`webp`。
- `output_path`：保存目录或完整文件路径。
- `overwrite`：是否覆盖已有文件，默认 `false`。
- `images`、`image_path`、`input_images`：图生图或编辑输入图片，支持本地路径、HTTPS URL 和 data URL。
- `mask`、`mask_path`：局部编辑遮罩图片。
- `background`：`auto` 或 `opaque`。
- `moderation`：`auto` 或 `low`。
- `idempotency_key`：幂等键，客户端超时后可用同一个键重试，避免同一进程内重复生成。

## 常见问题

### 为什么不直接用同步生成？

图片生成可能耗时较长。同步等待会让 MCP 客户端长时间占住连接，容易出现 `stream disconnected before completion` 一类问题。异步任务模式更稳定，也更适合高质量大图。

### 为什么下载结果默认不返回图片内容？

大图的 base64 很容易占满上下文，触发客户端频繁 compact 或断连。默认返回文件路径更稳定，需要图片内容时再设置 `include_image: true`。

### API Key 放在哪里？

推荐放在 MCP 配置的 `env.GPTEAM_API_KEY` 中。不要把真实 API Key 写进仓库、README、截图或公开日志。

## 安全说明

- 不要提交 `.env` 或真实 API Key。
- 出错信息会尽量隐藏 `sk-` 开头的密钥。
- 本 MCP 只会读取 `GPTEAM_API_KEY`，不会读取系统里的 `OPENAI_API_KEY` 当作 GPTeam Key。
