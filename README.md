# imagen

通过官方 OpenAI / Google SDK，为 Codex、VS Code + GitHub Copilot 和其他 agent 提供图片生成与编辑。采用 Agent Plugins 1.0 标准包，同时提供 npm CLI 和本地 stdio MCP 服务。

- npm：`@wdd817/imagen`
- CLI / Plugin：`imagen`
- Node.js：24 或更高版本，首发基线为 Node 24 LTS
- 许可证：MIT，Copyright © 2026 wdd817

## 支持范围

| 协议 / 平台 | SDK | 实现能力 |
| --- | --- | --- |
| Images API | `openai` | 生成、编辑、参考图、模型支持时的 mask |
| Responses API | `openai` | image_generation 工具模式；显式配置的兼容服务 direct 模式 |
| Gemini Developer API | `@google/genai` | 生成、目标图编辑、参考图 |
| Vertex Gemini | `@google/genai` | 生成、目标图编辑、参考图；显式 Google 凭据文件 |
| Vertex Imagen | `@google/genai` | SDK 的生成和 raw/mask 编辑映射；具体模型可用性受服务端限制 |

适配器实现、离线测试通过和某个服务商实测通过是不同的状态。当前结果见 [验证记录](docs/validation.md)。模型从 profile 选择；不会根据模型名称猜能力，也不会在失败后自动切换服务商或协议。

## 安装

```sh
npm install --global @wdd817/imagen@0.1.1
imagen --help
```

从源码开发：

```sh
npm ci
npm run typecheck
npm test
npm run build
node dist/imagen/runtime/imagen.mjs --help
```

标准插件产物在 `dist/imagen/`，含编译后的程序和所需依赖。使用该插件包时不需要安装 TypeScript 或在首次调用时下载依赖；本机仍需 Node。

## 配置 API

以官方 Gemini Developer API 为例，创建 profile 并输入 API key。交互输入不会显示密钥，也不会把密钥作为命令参数：

```sh
imagen configure --preset gemini
imagen configure --credential google
imagen doctor
imagen capabilities
```

若 key 已经在环境变量中，可以显式导入：

```sh
imagen configure --credential google --from-env GEMINI_API_KEY
```

Gemini 预设使用官方端点，并创建名为 `gemini` 的 profile。官方 OpenAI Images API 可使用 `imagen configure --preset openai`，再通过 `imagen configure --credential openai` 配置密钥。兼容服务通过自定义 profile 的 `baseUrl` 接入，实际地址和认证信息保存在个人配置中。

默认 CLI 数据目录是 `~/.imagen`：

| 文件 / 目录 | 用途 |
| --- | --- |
| `config.json` | profile、模型、端点与能力声明 |
| `credentials.json` | 通过名字引用的 API keys，不随导出配置发布 |
| `jobs/` | 状态与可恢复的生成结果 |

用 `--data-dir` 选择独立状态目录，`--config` 只改变 profile 文件位置。标准插件默认使用宿主分配的 `PLUGIN_DATA/imagen`；与 CLI 共用任务时需要显式选择同一数据目录。

## 生成与编辑

```sh
imagen generate --profile gemini --prompt "A blue mountain icon on a cream background" --out ./output
imagen edit --profile gemini --target ./output/source.png --prompt "Change the mountain to green" --out ./output
```

通过 `--reference` 添加参考图，可重复传入。`--mask` 仅适用于声明支持的编辑 profile。CLI 会把文件和输出目录解析成绝对路径；MCP 调用直接要求绝对路径。

CLI 前台等待生成结果，stdout 返回 JSON，stderr 显示 job ID；`--json` 可关闭普通进度提示。请求默认超时 5 分钟，可用 `--timeout-ms` 调整，最长 30 分钟。Gemini 和 Responses 工具模式一次请求只接受 `count=1`，不会为较大张数偷偷发出多次请求。

供应商参数通过 JSON 文件传入。例如 Gemini：

```json
{ "aspectRatio": "1:1", "imageSize": "1K" }
```

```sh
imagen generate --profile gemini --prompt "A blue mountain icon" --out ./output --options-file ./options.json
```

Images 常用参数为 `size`、`quality`、`output_format`，如 `{"size":"1024x1024","quality":"low","output_format":"png"}`。实际可用参数由 SDK、模型和 profile 共同决定；未知参数、关键参数冲突或不支持的能力不会静默忽略。

也可用 `--request request.json` 提交完整请求，包括稳定的 `requestId`、`profile`、`operation`、`prompt`、`outputDir`、`referenceImages` 和 `providerOptions`。相同 requestId 加相同内容返回原任务；请求或输入图片改变则返回冲突，不重复计费请求。

## 任务和恢复

```sh
imagen job JOB_ID
imagen wait JOB_ID
imagen recover JOB_ID
imagen cancel JOB_ID
```

MCP 的 `imagen_generate`、`imagen_edit` 快速返回 job ID；用 `imagen_job` 查询完成状态。服务进程需保持运行，首版没有后台系统守护进程。

- `succeeded`：图片已保存，结果包含绝对路径、实际 MIME、尺寸和 SHA-256。
- `failed` + `SAVE_FAILED`：远端已生成，但本地保存失败；修复输出目录后 recover，只恢复已有结果。
- `unknown`：发送后超时、断连或无法确认远端结果。先查状态，不能自动重新生成。
- `cancelled`：在排队阶段取消。运行中停止等待可能返回 unknown，不能保证远端停止或不计费。

另一个 CLI 进程可以查询任务；运行中的取消需交给提交任务的 MCP 进程。恢复操作不发出新的生成请求。输出文件不会覆盖不同内容的已有文件。

任务缓存可能包含完整生成图片；保存在用户状态目录，独立于输出目录。可在确认无需恢复后删除已完成任务对应的 `.result.json` 缓存。保留 `request-*.json` 和任务记录可继续进行去重查询。

## Vertex

```sh
imagen configure --preset vertex --project YOUR_PROJECT --location global --google-credentials /absolute/path/service-account.json
imagen generate --profile vertex-gemini --prompt "A ceramic cup beside a lemon" --out ./output
```

认证文件通过明确路径交给官方 Google SDK；不自动搜索未选择的全局凭据。示例中的项目、文件和区域需替换成你的配置。Vertex Gemini 和 Imagen 是不同的模型能力，不能互换生成与编辑型号。

## 自定义 Images / Responses profile

用 `imagen configure --export config.json` 导出非敏感配置，编辑后用 `imagen configure --import config.json` 导入。导入会备份已有配置。

```json
{
  "schemaVersion": 1,
  "defaultProfile": "my-images",
  "profiles": {
    "my-images": {
      "protocol": "images",
      "model": "gpt-image-2",
      "baseUrl": "https://api.openai.com/v1",
      "auth": { "kind": "apiKey", "credential": "openai" },
      "capabilities": { "generate": "supported", "edit": "supported", "references": "supported", "mask": "supported" },
      "evidence": "Provider-documented capabilities; verify model access in your account.",
      "maxCount": 1,
      "maxInputImages": 8
    }
  }
}
```

另用 `imagen configure --credential openai` 设置 key。Responses 使用 `protocol: "responses"`，`responsesMode: "tool"`，并选择服务商支持调用图像工具的主模型；可单独配置 `imageModel`。`responsesMode: "direct"` 是明确选择的兼容服务格式，绝不会自动从工具模式切换过去。

## 接入 agent

### 本地 MCP（npm 安装）

VS Code 工作区 `.vscode/mcp.json` 示例：

```json
{
  "servers": {
    "imagen": {
      "type": "stdio",
      "command": "imagen",
      "args": ["mcp", "--data-dir", "C:/Users/YOU/.imagen"]
    }
  }
}
```

其他 MCP 客户端使用相同命令，外层配置格式按客户端要求调整。纯 MCP 不会自动安装 Skill，可按客户端规则另行安装 `plugin/skills/imagen`。MCP 工具包括 `imagen_capabilities`、`imagen_generate`、`imagen_edit`、`imagen_job`、`imagen_cancel`、`imagen_recover`。

### Agent Plugins 标准包

下载发行版的标准插件包并解压；VS Code 启用插件并注册解压目录：

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": { "C:/Tools/imagen": true }
}
```

标准包的根目录包含 `plugin.json`、`mcp.json`、`skills/` 和 `runtime/`；不要将源码仓库自动生成的 ZIP 当作已构建插件。Codex 可通过包含该目录的本地 marketplace 安装。避免同时注册同一插件的 MCP 回退配置。

## 开发与发布

```sh
npm run typecheck
npm test
npm run build
npm run validate:plugin
npm pack
```

测试使用本地假服务或临时状态目录，不会使用真实 key 发起付费请求。真正的服务商兼容验证单独记录。标准包校验使用仓库固定的 Agent Plugins 1.0 schemas；构建产物包含第三方许可声明。

详细设计见 [开发计划](docs/development-plan.md)。
