# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.28.1] - 2026-09-10

### 修复

- **热更新模型在设置界面不可见**：辅助模型设置与视觉模型向导改经 `getConfigProvider()` 读取配置，合并远程热更新清单后展示模型。 [#398](https://github.com/VicBilibily/GCMP/issues/398)

---

### Fixed

- **Hot-updated models missing in settings UIs**: The auxiliary model settings panel and vision wizard now read provider configs via `getConfigProvider()`, merging the remote hot-update manifest when listing models. [#398](https://github.com/VicBilibily/GCMP/issues/398)

## [0.28.0] - 2026-09-09

### 新增

- **远程元数据分发机制与官网站点（gcmp.dev）**：扩展激活时与每 15 分钟定时从官网拉取远程元数据（Claude Code / Codex TUI 版本等），按 contentHash 增量缓存；新增 `GCMP: Refresh Remote Metadata` 手动刷新命令；官网同步上线，提供首页、文档与模型清单页。
- **远程模型清单热更新**：内置提供商的模型列表支持经远端清单增量更新；多窗口间由 Leader 实例统一拉取并写磁盘缓存，其余窗口经跨实例事件重读，行为一致；扩展开发宿主直接合并本仓库清单，与生产效果一致。
- **仅远端发布模型（remote-extra）**：免费额度、临时测试等可能随时失效的模型不再内置进插件包，经远端清单发布与下线，无需等待发版；构建期强校验未知 provider、模型 id 冲突与禁止字段（`baseUrl`/`endpoint`/`proxy` 等）；首个仅远端模型为 DeepSeek-V4.1-Flash (抢先体验)。
- **Codex User-Agent 自动生成与归一化**：对齐 codex CLI 官方实现生成 User-Agent（originator/版本/操作系统/终端标识），Codex 模型请求与额度查询统一携带；GPT 模型经 OpenAI Compatible 通道透传时自动补齐。
- **Claude Code User-Agent 自动补齐**：Anthropic Compatible 通道的 Claude 模型请求自动携带 Claude Code 风格 User-Agent。
- **Grok-4.6 补全 xhigh 推理强度**：Grok 与 OpenCode 通道的 Grok-4.6 模型支持 xhigh 推理强度。 [#396](https://github.com/VicBilibily/GCMP/issues/396)

### 修复

- **工具调用 ID 冲突与分片完成时机**：同一响应内重复的工具调用 id 自动改名避免相互覆盖；统一 OpenAI / Responses / Anthropic 各通道工具调用分片缓存的完成与重放时机，修复失败收尾误提交不完整工具调用、单 choice 完成误清理其他 choice 同 index 分片等问题。
- **流终态重复上报**：Responses 通道在 processor 已收口时不再重复 flush reporter，避免完成统计重复上报；同步修正 Codex 远程元数据字段。

### 移除

- **旧版 V1 Gist 同步下线**：移除旧版 QuickPick 同步界面（`GCMP: 管理/同步 API Key` 命令）、旧版 Gist 数据迁移入口（首次打开提示与「迁移旧版 Gist 数据」菜单项）及 V1 数据读写通道。API Key 跨设备备份请使用「API Key 管理」面板的 Gist 备份与恢复。

---

### Added

- **Remote metadata distribution & official site (gcmp.dev)**: Remote metadata (Claude Code / Codex TUI versions, etc.) is fetched on activation and every 15 minutes with contentHash-based incremental caching; added the `GCMP: Refresh Remote Metadata` command; the official site is live with home, docs, and model list pages.
- **Remote model list hot-update**: Built-in providers' model lists can be updated incrementally via a remote manifest; the Leader instance fetches and writes the disk cache while other windows reload via inter-instance events; the extension development host merges this repo's manifest directly, matching production behavior.
- **Remote-only models (remote-extra)**: Free-quota or temporary test models that may expire at any time are no longer bundled; they are published and retired via a remote manifest without shipping a release. Build-time validation rejects unknown providers, built-in id conflicts, and forbidden fields (`baseUrl`/`endpoint`/`proxy`, etc.). The first remote-only model is DeepSeek-V4.1-Flash (Preview).
- **Codex User-Agent generation & normalization**: Generates the User-Agent aligned with the official codex CLI implementation (originator/version/OS/terminal), applied to Codex model requests and quota queries; GPT models relayed through the OpenAI Compatible channel are patched automatically.
- **Claude Code User-Agent auto-fill**: Claude model requests on the Anthropic Compatible channel automatically carry a Claude Code-style User-Agent.
- **xhigh reasoning effort for Grok-4.6**: Grok-4.6 on both Grok and OpenCode channels now supports the xhigh reasoning effort. [#396](https://github.com/VicBilibily/GCMP/issues/396)

### Fixed

- **Tool call ID conflicts & chunk finalize timing**: Duplicate tool call ids within one response are auto-renamed to avoid clobbering; chunk-cache finalize/replay timing is unified across OpenAI / Responses / Anthropic channels, fixing cases where failed finalization committed incomplete tool calls or one choice's completion discarded another choice's chunks at the same index.
- **Duplicate terminal stream reporting**: The Responses channel no longer flushes the reporter again after the processor has finalized, preventing duplicate completion reporting; Codex remote metadata fields were corrected accordingly.

### Removed

- **Legacy V1 Gist sync retired**: Removed the legacy QuickPick sync UI (`GCMP: Manage / Sync API Keys` command), the legacy Gist migration entry points (first-open prompt and the "Migrate legacy Gist data" menu item), and the V1 data read/write pipeline. For cross-device API key backup, use the Gist backup & restore in the API Key management panel.

## 历史版本（仅保留现存主要功能）

### 0.27.0 - 0.27.14 (2026-08-20 - 2026-09-03)

- **API Key 管理面板**：新增 `gcmp.configSet.manage` 统一面板，按提供商/槽位管理多套配置（站点 + Key + 备注），支持 Gist 备份与跨设备恢复；Codex / Grok CLI 认证状态与订阅余量并入面板展示
- **跨实例多维度限流与任期机制**：provider 配置新增 `limit` 字段（rpm/rps/tpm/parallel 四个维度，支持子 provider 与模型级逐级覆盖），多个 VS Code 窗口共享 Leader 权威限流桶，超限时 FIFO 排队或匀速延迟；限流桶引入权威任期，Leader 切换经快照交接保持计数，不可用时自动降级单窗口本地桶
- **新增 `effort-only` thinkingFormat**：忽略 thinking 开关并将 reasoningEffort 原样透传（不做值映射），对 OpenAI（含 Responses）与 Anthropic 处理逻辑生效
- **新增 CommandCode 提供商与用量查询**：GOAT Plan 套餐模型经 OpenAI 兼容端点接入，状态栏与 API Key 管理面板支持余额与限频查询
- **智谱余额查询**：配额查询新增账户余额明细，tooltip 与 API Key 管理面板可查看累计充值、赠送金额、消费金额、可用余额
- **状态栏增强**：CommandCode 状态栏 tooltip 动态显示订阅套餐名称；多套配置的提供商 tooltip 底部新增 API Key 管理页切换链接

### 0.26.0 - 0.26.39 (2026-07-19 - 2026-08-20)

- **Token 定价与客户端成本估算**：支持输入/输出/缓存读/缓存写分项定价，按峰谷时段、服务等级与上下文大小分档；预估成本内联显示在 Token 下方，支持 USD/RMB 双币种与多日成本趋势图，并基于上一轮实际用量做增量预估
- **多窗口跨实例协同（Leader / Follower）**：基于本地 IPC 广播在多 VS Code 窗口间同步状态栏、实时指标、配置与 API Key 变更，IPC 不可用时自动降级文件系统轮询
- **状态栏用量查询扩充**：新增 OpenCode Go 套餐用量、Grok 订阅额度、Charm Hyper 余额、Kimi 加油包钱包与 ClinePass 用量查询展示
- **Token 用量视图增强**：新增多日成本趋势图、活跃日期多会话实时跟踪、正式会话标题回填与压缩后会话恢复桥接、按提供商统计的缓存命中率显示，并优化视图刷新性能
- **Anthropic 提示缓存自动管理**：自动注入与清理缓存断点、统一 `cacheTtl` 配置；重试改由外层统一调度，遵循服务端 `retry-after` / `x-should-retry` 头
- **加密思维链持久化**：StatefulMarker 将加密 reasoning / redacted_thinking 跨轮次持久化，ThinkingPart 被剥离时自动恢复
- **调试可观测**：新增 HAR 请求录制（自动脱敏、按时间轮换清理）

### 0.25.0 - 0.25.44 (2026-06-21 - 2026-07-17)

- **视觉分析工具集**：新增 7 个视觉分析工具（`#gcmpUiToArtifact`、`#gcmpExtractTextFromScreenshot`、`#gcmpDiagnoseErrorScreenshot`、`#gcmpUnderstandTechnicalDiagram`、`#gcmpAnalyzeDataVisualization`、`#gcmpUiDiffCheck`、`#gcmpAnalyzeImage`），统一由 `gcmp.vision.model` 配置的多模态模型驱动，支持 GitHub Copilot 原生视觉模型
- **辅助工具模型设置面板**：新增 `GCMP: 设置辅助工具模型` 命令与可视化面板，统一配置 Commit / Vision / Utility / Copilot Agent 模型
- **请求来源分类（requestKind）**：新增请求分类器，区分主 Agent、终端命令、代码解释、搜索子 Agent 等请求类型，并据此控制子请求思考模式
- **Compatible 提供商余额查询配置化**：支持通过 `gcmp.providerOverrides` 的 `usage` 字段声明式配置余额查询（JSON 路径提取、加减运算、成功条件判断）

### 0.23.0 - 0.24.16 (2026-05-30 - 2026-06-21)

- **Grok Build CLI (OAuth) 接入**：新增 `gcmp.grok` 提供商，支持通过 Grok Build OAuth 登录态访问 xAI 编程模型
- **全局代理链路统一**：新增 `gcmp.proxy`、`gcmp.tls.useSystemCertificates`，扩展提供商与模型级 `proxy` 覆盖；统一聊天请求、FIM/NES、模型发现、搜索、图片理解、状态栏查询、CLI OAuth 刷新及 MCP 客户端的代理感知链路
- **多日消耗分析视图**：用量面板新增「多日分析」标签页，支持跨日期趋势统计与可视化
- **重试开关**：新增 `gcmp.retry.enabled`（默认 `true`）

### 0.22.0 - 0.22.27 (2026-04-24 - 2026-05-30)

- **国际化与展示**：新增中英双语界面自动切换、ChatGPT 用量重置倒计时、Copilot 上下文窗口 `usage` 数据回传

### 0.21.0 - 0.21.20 (2026-03-27 - 2026-04-23)

- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度
- **请求重试机制**：统一由通用 Provider 处理自动重试，新增 `gcmp.retry.maxAttempts` 配置项

### 0.20.0 - 0.20.11 (2026-03-05 - 2026-03-23)

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持

### 0.18.0 - 0.19.17 (2026-01-23 - 2026-02-28)

- **Token 统计可视化**：新增平均输出速度、首 Token 延迟、小时统计图表等可视化功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **OpenAI Responses API 支持**：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
