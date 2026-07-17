# GPTEAM Image MCP

GPTEAM Image MCP 是 GPTEAM 图片生成与编辑能力的独立 MCP 发行入口。它不会在客户端写死分组、模型或上游参数，而是用当前 `GPTEAM_API_KEY` 调用 schema-v1 能力接口，动态生成这个 Key 此刻可以使用的模型、动作、执行 Profile、参数、默认值和约束。

同一个安装包可以适配后续新增分组和复用现有 Profile 的新模型；新增协议时，由 GPTEAM 后端补齐能力合同、执行适配器、调度和计费验证，MCP 仍只消费运行时合同。

## 安装

Node.js 需要 `18.18.0` 或更高版本。推荐先运行 `npx gpteam`，让 GPTEAM CLI 按当前 Key 写入客户端配置；也可以直接配置 GitHub 入口：

```json
{
  "mcpServers": {
    "gpteam_image": {
      "command": "npx",
      "args": ["-y", "github:Hsiangpo/GPTEAM-Image-MCP"],
      "env": {
        "GPTEAM_API_KEY": "<YOUR_GPTEAM_API_KEY>",
        "GPTEAM_BASE_URL": "https://api.gpteamservices.com"
      }
    }
  }
}
```

真实 Key 只放在本机 MCP 环境变量中，不要写进仓库、截图或日志。MCP 不会把 `OPENAI_API_KEY` 当作 GPTEAM Key。

## 动态能力流程

1. 调用 `get_capabilities`，读取当前 Key 的 schema-v1 能力合同。
2. 从返回结果中选择模型 `MODEL_FROM_CAPABILITIES`、动作 `generate` 或 `edit`，以及该执行 Profile 明确接受的参数。
3. 用同一组选择调用 `create_image_job`。
4. 用 `get_image_job_status` 查询任务；完成后用 `download_image_result` 获取文件和元数据。

不要根据旧文档猜模型名、尺寸、质量或供应商参数。分组、模型、Profile 或权限变化后，能力缓存最多保留 60 秒；任务在首次付费派发前还会强制刷新修订号。合同变化会在上游请求前返回 `stale_capability`，不会用旧能力继续派发。

## MCP 工具

- `get_capabilities`：返回当前 Key 的分组摘要、能力修订、模型、动作、Profile、参数约束、默认值、队列限制和可选实时可用性观察。
- `create_image_job`：校验运行时合同并创建异步图片任务，推荐入口。
- `get_image_job_status`：查询排队、运行、成功、失败、取消或过期状态。
- `cancel_image_job`：尽力取消排队中或运行中的任务。
- `download_image_result`：下载结果；可用 `metadata_only`、`include_image` 和 `include_revised_prompt` 控制返回体积。
- `generate_image`：旧客户端兼容别名，内部同样创建异步任务。

`tools/list` 也由当前能力合同动态生成。客户端不支持复杂 `oneOf` 工具 schema 时，MCP 只公开各可用 Profile 的安全参数交集，不会凭空合并互斥参数。

## 任务与结果

图片任务默认异步执行，创建后立即返回 `job_id`。这样长时间生成不会因为 MCP 客户端空闲超时而丢失整个任务。成功结果包括文件路径、模型、动作、Profile、能力修订、MIME 类型、实际宽高、字节数、SHA-256、耗时、`job_id` 和 `trace_id`。

本地写文件会创建缺失目录，并在未允许覆盖时自动使用 `-v2`、`-v3` 等文件名。`download_image_result` 默认可以只取元数据，避免把大图 base64 塞满客户端上下文。

GPTEAM 的部分 Profile 会接受自定义尺寸、比例、缩放或增强参数。请求尺寸控制合同校验、上游选择、构图提示和计费语义；返回图片保留上游实际字节，因此实际像素可能不同，但应保持合同允许的目标比例。最终以结果中的 `width` 和 `height` 为准。

## HTTPS 图片结果与代理

上游可能返回 base64/data URL，也可能返回公开 HTTPS 图片地址。MCP 下载 HTTPS 结果时不会携带 GPTEAM API Key，并会校验 DNS、重定向、内容类型、真实图片字节和 64 MiB 上限；本地、私网、保留地址、带凭证地址和类型不匹配结果都会失败关闭。下载失败不会重放已经可能付费的图片生成。

需要出网代理时设置：

```json
{
  "GPTEAM_IMAGE_RESULT_PROXY_URL": "http://127.0.0.1:PORT"
}
```

未设置时遵循标准 `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 和 `NO_PROXY`。代理凭证同样只放在本机私密环境中。

常用本地控制项：

- `GPTEAM_IMAGE_OUTPUT_DIR`：默认保存目录。
- `GPTEAM_IMAGE_REQUEST_TIMEOUT_MS`：单次请求硬超时。
- `GPTEAM_IMAGE_MAX_CONCURRENT`：本地并发任务数。
- `GPTEAM_IMAGE_MAX_QUEUE`：本地排队上限。
- `GPTEAM_IMAGE_RESULT_PROXY_URL`：仅用于公开 HTTPS 图片结果下载的代理。

## 稳定错误

- `model_required`：必须从本次 `get_capabilities` 结果选择模型。
- `unsupported_parameter`：字段不属于所选模型、动作或 Profile。
- `stale_capability`：排队后能力修订、分组、权限、模型或 Profile 已变化；重新读取能力并新建任务。
- `image_url_proxy_invalid`：图片结果代理配置无效或协议不受支持。

认证失败、空能力、畸形 schema、未知 schema 主版本、未注册 Provider 和刷新失败都会失败关闭，不会恢复静态默认模型。一次请求只要可能已到达上游，就不会自动重放。

## 本地验证

```bash
git clone https://github.com/Hsiangpo/GPTEAM-Image-MCP.git
cd GPTEAM-Image-MCP
npm install
npm test
npm pack --dry-run --json
```

本仓库是 GPTEAM monorepo 的生成发行镜像，不是第二份手工实现源。功能改动先进入 `Hsiangpo/GPTEAM`，再由确定性发行清单同步并验证本仓库。
