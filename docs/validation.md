# imagen 0.1.0 验证记录

日期：2026-09-07。以下结果针对本次实际账号、端点及模型，不推断同协议的所有服务商均兼容。

## 真实 API

| 服务 / 模型 | 生成 | 编辑 | 说明 |
| --- | --- | --- | --- |
| example Gemini / `gemini-3.1-flash-image` | 成功，1024×1024 PNG | 成功，1024×1024 PNG | 蓝色山峰改为绿色，太阳和背景保留 |
| example Images / `gpt-image-2` | 成功，1024×1024 PNG | 成功，1254×1254 PNG | 红杯改为青蓝色，主体与构图保留；编辑后的尺寸可能变化 |
| example Responses / `gpt-image-2` | 测试请求 HTTP 400 | 未验证 | 工具、direct、stream 和最小请求均返回操作不支持；无版本前缀路径为 HTTP 405 |
| Vertex Gemini / `gemini-3.1-flash-image` | 成功，1024×1024 PNG | 成功，1024×1024 PNG | 红杯改为蓝杯，柠檬及构图保留；显式服务账号凭据，global 区域 |
| Vertex Imagen / `imagen-4.0-generate-001` | HTTP 404 | 未验证 | 该项目/区域未能访问此模型；不声明此模型已实测可用 |

生成产物经过格式、尺寸检查及目视验证。example Images 的缓存响应也通过 SDK adapter 的本地回放解析，未为解析检查重复生图。项目 ID、凭据、完整 API 响应及私人工作区路径不纳入公开验证记录。

Responses adapter 的工具/兼容格式通过真实 SDK 与本地假服务的契约测试，但 example 的上述模型组合尚未通过。预设将该 profile 标为 unknown，默认使用已验证的 Gemini 路径；`gpt-image-2` 使用已验证的 Images profile。不会自动修改用户选择的模型或协议。

## 本地自动化

- OpenAI / Google：用真实 SDK 连接本地 HTTP 假服务，覆盖参数、multipart、输出解析、错误、超时、取消与请求次数。
- 核心：并发请求去重、输入冲突、能力拦截、队列取消、未知状态、保存恢复、进程退出、状态写入失败与文件不覆盖。
- 配置：key 不进入命令输出或导出配置，损坏配置不会被预设覆盖；Windows ACL 清除已有 Everyone 显式读取权限。
- MCP：两代协议握手、六个工具、无凭据启动、错误脱敏、SHA 校验的受控预览。
- 打包：官方 Agent Plugins 1.0 schema 与路径验证；仅复制 bundle 到独立目录也可启动 MCP。

完整命令为 `npm run typecheck`、`npm test`、`npm run build`、`npm run validate:plugin`。具体运行总数随回归测试增加而更新，以当前测试输出为准。

## 客户端与发行

Codex CLI 0.153.4 已成功安装标准包，实际调用 `imagen_capabilities`、生成、查询、编辑并获得成功结果。非交互会话通过 CLI 自带的自动审批流程完成写工具授权；未更改工具的权限标注或绕过审批。

VS Code 1.136.1 + GitHub Copilot 通过本地标准插件完成生成、编辑；用户确认成功调用并可以看到图片，工作区存在两张对应 PNG 产物。

本机完整回归为 56 项通过、0 失败，另 1 项 POSIX 权限测试按平台跳过。npm tarball 已在含空格路径的独立目录安装，通过 Windows CLI shim 的版本和离线 doctor 检查；doctor 未发起网络请求。

源码仓库位于 [wdd817/imagen](https://github.com/wdd817/imagen)。Windows、Linux、macOS 三个平台的 [GitHub Actions 验证均通过](https://github.com/wdd817/imagen/actions/runs/34096786040)。
