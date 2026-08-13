# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.26.33] - 2026-08-13

### 新增

- **新增 Grok 4.6 模型**：xAI 最新旗舰，500K Token 上下文，支持推理档位（low/medium/high）与联网搜索，可按官方定价分层计费。
- **ClinePass 新增 Qwen3.8-Max 模型**：`cline-pass/qwen3.8-max` 支持工具调用与图片输入，百万 Token 上下文，按 ClinePass 规格计费。
- **DeepSeek-V4-Pro 改用 OpenAI Responses 接口**：`deepseek-v4-pro` 由 Anthropic 接口切换为 `openai-responses`，并新增联网搜索工具支持。

### 变更

- **OpenCode 的 DeepSeek-V4 系列新增 `low` 推理档位**：补齐 reasoning effort 的 `low` 选项，覆盖 flash/pro 的 GO 与 ZEN 接入。

---

### Added

- **Added Grok 4.6**: xAI's newest flagship with a 500K-token context window, reasoning tiers (low/medium/high), and web-search support, billed at the official tiered pricing.
- **Added Qwen3.8-Max to ClinePass**: `cline-pass/qwen3.8-max` supports tool calling and image input with a 1M-token context window, billed per ClinePass pricing.
- **DeepSeek-V4-Pro now uses the OpenAI Responses API**: `deepseek-v4-pro` switched from the Anthropic API to `openai-responses` and gained web-search tool support.

### Changed

- **OpenCode's DeepSeek-V4 family now offers a `low` reasoning effort tier**: the `low` option was added across the GO and ZEN entries of flash/pro.

## [0.26.32] - 2026-08-12

### 新增

- **Charm Hyper 余额接入 Compatible 状态栏**：Hyper 现在作为内置余额查询并入 Compatible 状态栏；预置查询会优先加入查询队列并与自定义接入一起展示。

---

### Added

- **Charm Hyper balance is now surfaced in the Compatible status bar**: Hyper is now bundled as a built-in balance query in the Compatible status bar; built-in queries are added to the queue ahead of custom entries.

## [0.26.31] - 2026-08-12

### 新增

- **新增 OpenCode 用量状态栏**：支持通过 OpenCode 官方已上线的用量接口查询 Go 套餐的滚动 / 每周 / 每月额度，并在状态栏与 Tooltip 中显示剩余百分比、倒计时和重置时间。

---

### Added

- **Added OpenCode usage status bar**: GCMP can now query the officially deployed OpenCode usage endpoint and display Go plan rolling / weekly / monthly quota windows in the status bar and tooltip, including remaining percentage, countdown, and reset time.

## [0.26.30] - 2026-08-11

### 新增

- **Compatible 自定义余额/用量查询支持乘除与常量换算**：`gcmp.providerOverrides.{provider}.usage` / `usages` 的计算字段新增 `multiply` / `divide`，`paths` 现在也可直接写常量数值，支持 `quota / 500000` 这类 Ticket 到真实货币余额的换算场景。

---

### Added

- **Compatible custom balance/usage queries now support multiplication, division, and constant-value conversions**: computed fields in `gcmp.providerOverrides.{provider}.usage` / `usages` now support `multiply` and `divide`, and `paths` can include constant numbers directly, enabling conversions such as `quota / 500000` from Ticket units to real currency balance.

## [0.26.29] - 2026-08-10

### 修复

- **GPT 模型缺少 reasoning 配置时不再回传明文思维链**：[#352](https://github.com/VicBilibily/GCMP/issues/352) 0.26.24 仅处理 `include` 被显式接管的场景，但 GPT 端点在未配置 `extraBody.reasoning` 时，历史 reasoning 摘要仍会被当作明文 `reasoning_text` 回传，服务端因此拒绝请求并返回 `array_above_max_length`。现统一收敛为：GPT 端点永远不回传明文历史 reasoning，仅 DeepSeek 等非 GPT 端点继续兼容明文回放。

---

### Fixed

- **GPT models without `extraBody.reasoning` no longer replay plaintext reasoning**: [#352](https://github.com/VicBilibily/GCMP/issues/352) 0.26.24 only covered the case where `include` was explicitly overridden. When a GPT model lacked `extraBody.reasoning`, historical reasoning summaries could still be replayed as plain `reasoning_text`, causing the server to reject the request with `array_above_max_length`. The rule is now unified: GPT endpoints never replay historical reasoning in plaintext, while non-GPT endpoints such as DeepSeek keep plaintext replay compatibility.

## [0.26.28] - 2026-08-10

### 修复

- **Codex 配额状态事件不再误拦截正常请求**：[#349](https://github.com/VicBilibily/GCMP/issues/349) 0.26.27 将流中 `codex.rate_limits` 的 `allowed: false` / `limit_reached: true` 标记为永久错误直接失败，但经对照官方 Codex CLI 源码确认：该事件只是配额状态告知（用于刷新状态栏），并非"本次请求被拒绝"的信号——即使限额已满，后端仍会接受并完成当前请求（紧随其后出现 `response.created`）。现改为仅记录状态日志、不再中断流；真正的拒绝仍由 HTTP 429 + `usage_limit_reached` 或 SSE `response.failed` 表达，重试分类逻辑不变。

---

### Fixed

- **Codex quota status events no longer block valid requests**: [#349](https://github.com/VicBilibily/GCMP/issues/349) 0.26.27 classified explicit limit signals (`allowed: false` / `limit_reached: true`) in `codex.rate_limits` as permanent errors and failed fast. Cross-checking the official Codex CLI source confirmed this event is a quota-status notification (used to refresh the status bar), not a rejection signal — even with limits reached, the backend still accepts and completes the current request (`response.created` follows immediately). It now only logs the status and no longer breaks the stream; real rejections still surface via HTTP 429 + `usage_limit_reached` or SSE `response.failed`, and retry classification is unchanged.

## [0.26.27] - 2026-08-10

### 修复

- **Codex 配额事件不再导致 Responses 流崩溃**：[#349](https://github.com/VicBilibily/GCMP/issues/349) Codex 后端在 Responses 流开头推送的 `codex.rate_limits` 配额事件（`allowed: true`）此前因过滤不完整残留 `event:` 行，导致 SDK 对空 data 做 `JSON.parse` 抛 `Unexpected end of JSON input`；现在 event 行与 data 行一并过滤，配额状态推送不再中断正常请求。
- **Codex 明确限流不再无意义重试**：[#349](https://github.com/VicBilibily/GCMP/issues/349) Codex 流中 `codex.rate_limits` 的 `allowed: false` / `limit_reached: true` 明确限额信号，此前被当作可重试的 429 反复重试，现在标记为永久错误直接失败；Compatible 自定义接入仍可通过重试切换上游路由恢复，行为不变。
- **HTTP 408 超时支持自动重试**：[#351](https://github.com/VicBilibily/GCMP/issues/351) 上游返回 408 Request Timeout（如 HuggingFace 推理冷启动/排队超时）此前直接抛给用户，现在视为瞬时超时进入重试；永久错误否决仍优先，不会误重试额度耗尽等。
- **状态码消息兜底不再误报**：含 408/429/529 数字的文案（如模型名、token 计数）此前会被当作可重试状态码误判，现改用精确正则匹配 `HTTP/Status/Upstream error` 上下文，消除误重试。

### 新增

- **火山方舟 DeepSeek-V4-Flash 正式版**：新增 `deepseek-v4-flash-ga-260731` 模型，Agent 能力大幅增强，支持思考/非思考双模式与百万 Token 上下文。

---

### Fixed

- **Codex quota events no longer crash Responses streams**: [#349](https://github.com/VicBilibily/GCMP/issues/349) the `codex.rate_limits` quota event (`allowed: true`) Codex pushes at the start of Responses streams previously left a dangling `event:` line after filtering, causing the SDK to `JSON.parse` an empty data field and throw `Unexpected end of JSON input`; the event and data lines are now filtered together, so quota-status push no longer breaks normal requests.
- **Codex explicit rate limit is no longer retried pointlessly**: [#349](https://github.com/VicBilibily/GCMP/issues/349) explicit limit signals (`allowed: false` / `limit_reached: true`) in `codex.rate_limits` were previously retried as a transient 429; they are now classified as permanent errors and fail fast. Compatible custom providers still recover via retry-driven upstream route switching, unchanged.
- **HTTP 408 timeout is now retried**: [#351](https://github.com/VicBilibily/GCMP/issues/351) upstream 408 Request Timeout responses (e.g. HuggingFace inference cold-start/queue timeouts) previously surfaced directly to the user; they are now treated as transient timeouts and retried. Permanent-error veto still takes precedence, so quota exhaustion is never retried.
- **Status-code message fallback no longer false-positives**: messages containing 408/429/529 as substrings (e.g. model names, token counts) were previously misclassified as retryable status codes; the fallback now uses precise regex matching against `HTTP/Status/Upstream error` context, eliminating spurious retries.

### Added

- **Volcengine DeepSeek-V4-Flash GA**: added the `deepseek-v4-flash-ga-260731` model with stronger agentic capabilities, dual thinking/non-thinking modes, and 1M-token context.

## [0.26.26] - 2026-08-08

### 修复

- **Compatible 接入的套餐限额 429 支持重试恢复**：[#347](https://github.com/VicBilibily/GCMP/issues/347) Compatible 自定义接入的上游网关透传 Codex 账号套餐限额错误（`usage_limit_reached`）时，不再按永久错误直接失败，而是视作可重试的限流错误，通过重试让网关切换上游账号路由恢复；内置 Codex 的永久限额判定保持不变。

---

### Fixed

- **Compatible providers now retry plan-limit 429 errors**: [#347](https://github.com/VicBilibily/GCMP/issues/347) when a custom Compatible provider's gateway passes through a Codex account plan-limit error (`usage_limit_reached`), it is treated as a retryable rate-limit error instead of a permanent failure, letting retries switch the gateway's upstream account route to recover. The built-in Codex provider's permanent-limit classification is unchanged.

## [0.26.25] - 2026-08-08

### 修复

- **OpenAI Responses include 接管时不再回传明文思维链**：[#345](https://github.com/VicBilibily/GCMP/issues/345) 当 `extraBody.include` 被显式接管为 `null` / `[]` 时，历史思维链不再以明文 `reasoning_text` 回传，避免 GPT/Azure 端点因输入端 reasoning content 非空而报 400。

---

### Fixed

- **OpenAI Responses plaintext reasoning is no longer replayed when `include` is overridden**: [#345](https://github.com/VicBilibily/GCMP/issues/345) when `extraBody.include` is explicitly overridden to `null` / `[]`, historical reasoning is no longer replayed as plain `reasoning_text`, avoiding 400s on GPT/Azure endpoints that require empty input-side reasoning content.

## [0.26.24] - 2026-08-07

### 修复

- **OpenAI Responses 加密思考回放兼容 Azure 多资源中转**：[#345](https://github.com/VicBilibily/GCMP/issues/345) 当 `extraBody.include` 显式设置为 `null` / `[]` 时，不再自动注入 `reasoning.encrypted_content`，回放侧也同步关闭密文回传，避免跨资源校验失败。
- **OpenAI Responses 明文模式通道支持**：[#345](https://github.com/VicBilibily/GCMP/issues/345) 当 `extraBody.include` 被接管为 `null` / `[]` 时，历史思维链会以明文 `reasoning_text` 回传，并在 ThinkingPart 被剥离时从 StatefulMarker 恢复，适配无密文端点。

---

### Fixed

- **OpenAI Responses encrypted reasoning replay now respects Azure multi-resource proxies**: [#345](https://github.com/VicBilibily/GCMP/issues/345) when `extraBody.include` is explicitly set to `null` / `[]`, `reasoning.encrypted_content` is no longer auto-injected, and replay also stops sending historical ciphertext to avoid cross-resource validation failures.
- **OpenAI Responses plaintext channel support**: [#345](https://github.com/VicBilibily/GCMP/issues/345) when `extraBody.include` is taken over as `null` / `[]`, historical reasoning is replayed as plain `reasoning_text`, and stripped ThinkingPart entries are restored from StatefulMarker for plaintext endpoints.

## [0.26.23] - 2026-08-06

### 新增

- **视觉工具支持在提示中引用**：7 个视觉工具（UI 转 Artifact、截图文本提取、错误截图诊断、技术图表理解、数据可视化分析、UI 差异检查、通用图像分析）现可在 Chat 输入 `#` 手动引用，并出现在附件菜单中可单独启用/禁用。

### 变更

- **多日用量视图刷新优化**：自动刷新时复用图表实例增量更新数据，不再销毁重建整个视图，消除刷新频闪。

### 修复

- **修复切换模型后压缩导致的会话分裂**：切换提供商并触发上下文压缩时，会话无法跨提供商桥接（此前仅子代理分支支持），用量统计会按新会话继续。

---

### Added

- **Vision tools can now be referenced in prompts**: The 7 vision tools (UI-to-Artifact, screenshot text extraction, error screenshot diagnosis, technical diagram understanding, data visualization analysis, UI diff check, general image analysis) can now be manually referenced with `#` in Chat and appear in the attachments menu where each can be toggled individually.

### Changed

- **Multi-day usage view refresh optimization**: Auto-refresh now reuses chart instances and updates data incrementally instead of destroying and rebuilding the whole view, eliminating flicker.

### Fixed

- **Fix session split after model switch with compaction**: Switching providers and triggering context compaction previously could not bridge the session across providers (only the subagent branch supported it), so usage stats continued under a new session.

## [0.26.22] - 2026-08-04

### 变更

- **Anthropic 思考预算不再默认注入**：`thinking` 开启时不再主动补 `budget_tokens`（原固定 1024 最小值会压缩模型思考强度），仅在 extraBody 显式配置时透传；内置模型均为国内 Anthropic 兼容端点，不要求该参数。

---

### Changed

- **Anthropic thinking budget no longer injected by default**: `budget_tokens` is no longer auto-filled when thinking is enabled (the previous fixed 1024 minimum capped model thinking depth); explicit extraBody values are still passed through. All built-in models target Anthropic-compatible endpoints that do not require this parameter.

## [0.26.21] - 2026-08-04

### 变更

- **火山方舟 MiniMax-M2.7 与 Kimi-K2.6 标识即将下线（[#340](https://github.com/VicBilibily/GCMP/issues/340)）**：两款模型（CodingPlan / AgentPlan）将于 2026-08-18 14:00（UTC+8）停止服务，已在模型描述中标注 EOS 时间，到期后将移除。
- **MiniMax M2 系列精简**：MiniMax 官方、腾讯云渠道移除 M2.5 及以下旧型号，保留 M2.7；阿里云百炼渠道的 M2 系列全部移除。
- **腾讯云 Kimi-K2.5 移除**：模型已下线，CodingPlan / TokenPlan / TokenHub / Token Plan 企业版接入点同步移除。

### 修复

- **修复 settings.json 配置 schema 误挂载（[#341](https://github.com/VicBilibily/GCMP/pull/341)）**：schema 匹配改为精确的用户 / 机器 / Profile / 工作区设置文件路径，不再挂载到默认设置编辑器；根节点放宽对象类型校验，兼容个性化配置内容。

---

### Changed

- **Volcengine MiniMax-M2.7 & Kimi-K2.6 marked as end-of-service ([#340](https://github.com/VicBilibily/GCMP/issues/340))**: Both models (CodingPlan / AgentPlan) will be retired at 2026-08-18 14:00 (UTC+8); the EOS time is noted in the model descriptions and they will be removed afterwards.
- **MiniMax M2 series trimmed**: M2.5 and older removed from MiniMax official and Tencent Cloud, with M2.7 retained; the M2 series fully removed from AliDashScope.
- **Tencent Cloud Kimi-K2.5 removed**: The model has been retired; removed from CodingPlan / TokenPlan / TokenHub / Token Plan Enterprise endpoints.

### Fixed

- **Fix settings.json schema misattachment ([#341](https://github.com/VicBilibily/GCMP/pull/341))**: The schema now matches only the exact User / Machine / Profile / Workspace settings file paths, no longer attaching to the default settings editor; the root object type check is relaxed to tolerate personalized config content.

## [0.26.20] - 2026-08-04

### 新增

- **新增 Charm Hyper Qwen3.8-Max 与 DeepSeek-V4-Flash-0731（[#337](https://github.com/VicBilibily/GCMP/issues/337)）**：Hyper 渠道新增两款模型。

### 变更

- **移除 only-thinking 响应的 DONE 占位符适配**：模型仅输出思维链无正文时，不再输出 `DONE` 占位符（fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)）。

---

### Added

- **Charm Hyper Qwen3.8-Max & DeepSeek-V4-Flash-0731 ([#337](https://github.com/VicBilibily/GCMP/issues/337))**: Two new models in the Hyper channel.

### Changed

- **Removed DONE placeholder for thinking-only responses**: The `DONE` placeholder is no longer emitted when a model returns only reasoning without text (fixes [#260](https://github.com/VicBilibily/GCMP/issues/260)).

## [0.26.19] - 2026-08-03

### 修复

- **修复 Qwen3.8 调用 file_search 直接中断对话**：DashScope 普通接入点与 Token Plan 团队版/个人版的 Qwen 系列模型由 Responses API 端点回退至 Anthropic 兼容端点，规避百炼 Responses 端点将 Copilot 的 `file_search` 函数工具误判为内置知识检索工具的服务端缺陷；同步移除内置工具（web_search/web_extractor）注入，百炼 Anthropic 端点不支持内置工具能力。[#336](https://github.com/VicBilibily/GCMP/issues/336)

---

### Fixed

- **Fix Qwen3.8 conversation interruption on file_search calls**: Qwen models on the standard DashScope endpoint and Token Plan Team/Personal revert from the Responses API endpoint to the Anthropic-compatible endpoint, working around a DashScope server-side bug that misidentifies Copilot's `file_search` function tool as its built-in knowledge-retrieval tool. Built-in tool injection (web_search/web_extractor) is removed accordingly, as DashScope's Anthropic endpoint does not support built-in tools. [#336](https://github.com/VicBilibily/GCMP/issues/336)

## [0.26.18] - 2026-08-03

### 新增

- **Compatible 自定义模型服务等级选择**：模型声明的服务等级按原值透传给接口，兼容各家端点的私有枚举（如 OpenAI 的 `default`/`auto`/`flex`/`priority`、官方 Anthropic 的 `standard_only`/`auto`、MiniMax Anthropic 端点的 `default`/`priority`）；模型编辑器按 sdkMode 提供常见值勾选并支持拖拽排序，首项作为模型选择器默认值，settings.json 中也可填写端点自定义值。

---

### Added

- **Service tier selection for Compatible custom models**: Declared service tiers are sent to the endpoint as-is, covering vendor-specific enums (e.g. OpenAI `default`/`auto`/`flex`/`priority`, official Anthropic `standard_only`/`auto`, and `default`/`priority` on MiniMax's Anthropic endpoint). The model editor offers sdkMode-aware suggestions with drag ordering; the first item is the model picker default, and custom endpoint values can be set directly in settings.json.

## [0.26.17] - 2026-08-03

### 新增

- **新增 Qwen3.8-Max 正式版**：普通接入点与 Token Plan 团队版/个人版同步接入。[#334](https://github.com/VicBilibily/GCMP/issues/334)
- **新增 DeepSeek-V4-Flash-0731**：普通接入点与 Token Plan 团队版/个人版同步接入。

---

### Added

- **Qwen3.8-Max GA**: Added across standard, Token Plan Team/Personal. [#334](https://github.com/VicBilibily/GCMP/issues/334)
- **DeepSeek-V4-Flash-0731**: Added across standard, Token Plan Team/Personal.

## [0.26.16] - 2026-08-01

### 新增

- **Grok 订阅额度状态栏**：展示 Grok/SuperGrok 订阅剩余额度与重置时间，优先每周额度，统一账单账户回退月度额度。
- **Grok 独立代理设置**：支持 `gcmp.providerOverrides.grok.proxy` 独立代理与 `GROK_CLI_CHAT_PROXY_BASE_URL` 环境变量覆盖 billing 服务地址。

---

### Added

- **Grok subscription quota status bar**: Displays remaining Grok/SuperGrok subscription quota and reset time, preferring weekly quota with monthly fallback for unified-billing accounts.
- **Independent Grok proxy settings**: Supports `gcmp.providerOverrides.grok.proxy` proxy and `GROK_CLI_CHAT_PROXY_BASE_URL` env override for the billing service URL.

## [0.26.15] - 2026-08-01

### 新增

- **OpenCode Go 套餐新增 GPT-5.6-Luna**：支持 web 搜索、视觉输入与 reasoning effort 调节，长上下文 272K+ 触发高档计费。
- **DeepSeek 官方渠道 V4-Flash 调整为 Codex 模式兼容接口**：sdkMode 改为 `openai-responses`，新增 `low` reasoning effort 与 web 搜索能力；Pro 模式保持 Anthropic 兼容端点。

---

### Added

- **OpenCode Go plan adds GPT-5.6-Luna**: Supports web search, image input, and reasoning effort control, with a higher pricing tier above 272K context.
- **DeepSeek official channel V4-Flash switched to Codex-compatible interface**: sdkMode follows to `openai-responses`; adds `low` reasoning effort and web search; Pro mode retains the Anthropic-compatible endpoint.

## [0.26.14] - 2026-07-31

### 变更

- **Codex GPT-5.6 Terra / Luna 降价**：跟进 OpenAI 7 月 30 日官宣，Terra 标准价下调 20%、Luna 标准价下调 80%，priority 档（Fast mode）按 2× 标准价同步下调。[#327](https://github.com/VicBilibily/GCMP/issues/327)

---

### Changed

- **Codex GPT-5.6 Terra / Luna price cut**: Following OpenAI's July 30 announcement, Terra Standard drops 20% and Luna Standard drops 80%; priority tier (Fast mode) drops to 2× the new Standard price on both. [#327](https://github.com/VicBilibily/GCMP/issues/327)

## [0.26.13] - 2026-07-30

### 变更

- **移除 `editTools` 模型配置**：stable 构建禁用 proposed API 后该字段会触发注册失败，相关配置项一并清理，并新增运行时兜底过滤。
- **系统提示词改用内部标记**：GCMP 自构造的系统提示词改用 `User` role + `name="gcmp-system"` 标记，handler 转换层再转为 provider 的 system / instructions 字段。

---

### Changed

- **Drop `editTools` model config**: The field is removed because stable builds reject the underlying proposal; a runtime guard covers any leftover entries.
- **System prompts use an internal marker**: GCMP-constructed system prompts now use `User` role + `name="gcmp-system"`; handler converters re-emit them as the provider's system / instructions field.

## [0.26.12] - 2026-07-30

### 新增

- **会话恢复桥接**：压缩摘要（summarization）完成后，下一轮正式请求丢失 StatefulMarker 时，依次通过摘要文本、trace、turn 桥接自动恢复原 sessionId，用量统计不再被切碎为新会话；Explore / Execution 子代理请求可跨提供商沿父会话归组。
- **用量视图展示正式会话标题**：VS Code 生成的会话标题（chat-title 请求响应）自动回填到用量视图，会话列表与详情头部优先展示标题而非短 ID；历史标题从 usage 日志快照懒恢复。

### 变更

- **请求分类收紧**：真实 compaction 提示需同时满足固定前缀与三条必备标记才判为 summarization，避免用户粘贴的 prompt 片段被误分类。

### 修复

- **Codex / ClinePass 用量限额不再无意义重试**：`usage_limit_reached`、`INFERENCE_CAP_ERROR`、`SPEND_LIMIT_EXCEEDED`、`insufficient_credits` 及余额耗尽（current_balance ≤ 0）等永久性错误，即使文案命中 "please try again later" 也不再进入任何重试分支。
- **多会话跟踪块顺序不再跳动**：今日多选跟踪的会话块改按会话开始时间排序，不再因某会话有新请求完成而重新排列。

---

### Added

- **Session recovery bridge**: After a summarization (compaction) request completes, if the next formal request loses its StatefulMarker, the original sessionId is automatically restored via summary-text, trace, or turn bridges in order, so usage stats are no longer fragmented into new sessions; Explore / Execution subagent requests follow the parent session across providers.
- **Official session titles in the usages view**: Titles generated by VS Code (chat-title request responses) are automatically backfilled into the usages view; session list and detail headers prefer the title over the short ID. Historical titles are lazily restored from usage-log snapshots.

### Changed

- **Request classification tightened**: A genuine compaction prompt must match both the fixed prefix and all three required markers to be classified as summarization, preventing misclassification of user-pasted prompt fragments.

### Fixed

- **Codex / ClinePass usage limits no longer retried pointlessly**: Permanent errors such as `usage_limit_reached`, `INFERENCE_CAP_ERROR`, `SPEND_LIMIT_EXCEEDED`, `insufficient_credits`, and balance depletion (current_balance ≤ 0) never enter any retry branch, even when the message says "please try again later".
- **Tracked session blocks no longer jump around**: Multi-selected session blocks on today's view are now ordered by session start time, so they no longer reshuffle when a session completes a new request.

## [0.26.11] - 2026-07-28

### 新增

- **活跃日期多会话实时跟踪**：用量视图在今日支持 Ctrl/Cmd 多选 2-3 个会话进行实时跟踪，紧凑块展示，不分页，按高度自动裁减。

### 变更

- **会话与底部统计只算成功完成的请求**：token、成本、速度、延迟、耗时不再计入取消和失败的请求；请求总数、状态计数与时间范围仍覆盖全部记录。

---

### Added

- **Multi-session live tracking on the active date**: On today's view, hold Ctrl/Cmd to multi-select 2-3 sessions for live tracking; rendered as compact blocks without pagination and auto-trimmed by height.

### Changed

- **Session & bottom stats now count only completed requests**: Token / cost / speed / latency / duration no longer include cancelled or failed requests; request count, status counts, and time range still cover all records.

## [0.26.10] - 2026-07-28

### 模型与提供商配置

- **[新增] 阿里云百炼 Kimi-K3 / MiniMax-M3 / Qwen3.7-Flash**：均支持 1M 上下文 + 视觉理解；Qwen3.7-Flash 走 Responses API，自带 `web_search` / `web_extractor` 原生工具。
- **[新增] Charm Hyper Kimi-K3 与 Qwen3.7-Flash（[#322](https://github.com/VicBilibily/GCMP/pull/322)）**：Hyper 渠道新增两款模型。
- **[新增] Moonshot Kimi K3 256K**：256K 窗口版，`max / high / low` 三档思考，Moderato 及以上会员可用。
- **[新增] OpenCode Kimi-K3 (Zen) 与 Hy3 (Go)**：Zen 渠道新增 Kimi-K3（1M、视觉输入），Go 渠道新增 Hy3。
- **[变更] 阿里云百炼 Coding Plan 精简与按量模型 ID 规范化**：移除 `Qwen3.5-Plus` / `Qwen3-Max` / `Qwen3-Coder-Next` / `Qwen3-Coder-Plus` / `GLM-4.7`；`kimi-k3` → `kimi/kimi-k3`。
- **[变更] 腾讯云移除 Hy3 preview**（TokenHub / TokenPlan 双渠道）。

### 加密思维链持久化与恢复

- **[新增] StatefulMarker 加密思维链持久化**：`encrypted reasoning` / `redacted_thinking` 跨轮次持久化，ThinkingPart 被剥离时可自动恢复。
- **[变更] Responses 历史消息转换调整**：优先保留 `redactedData`，空 ThinkingPart 不再生成空 assistant message。
- **[修复] 历史消息加密思维链丢失**：VS Code 1.130+ 下 ThinkingPart 剥离导致无法回传加密 reasoning；同时修正 `StreamReporter` 的 metadata 字段名（`data` → `redactedData`）。

### 调试与测试

- **[新增] HAR 调试定位增强**：新增微秒时间戳、请求序号与状态时间戳，可从状态栏 tooltip 直接打开 HAR 文件。
- **[新增] VS Code 集成测试链路**：新增 `compile/typecheck/test:vscode` 脚本，覆盖 Responses / Anthropic 思维链恢复场景。

---

### Model & Provider Configuration

- **[Added] AliDashScope Kimi-K3 / MiniMax-M3 / Qwen3.7-Flash**: All support 1M context + vision input; Qwen3.7-Flash uses the Responses API with native `web_search` / `web_extractor` tools.
- **[Added] Charm Hyper Kimi-K3 & Qwen3.7-Flash ([#322](https://github.com/VicBilibily/GCMP/pull/322))**: Two new models in the Hyper channel.
- **[Added] Moonshot Kimi K3 256K**: 256K-window tier with `max / high / low` reasoning; available to Moderato and above members.
- **[Added] OpenCode Kimi-K3 (Zen) & Hy3 (Go)**: Zen channel adds Kimi-K3 (1M, vision); Go channel adds Hy3.
- **[Changed] AliDashScope Coding Plan streamlined & pay-as-you-go ID normalization**: Removed `Qwen3.5-Plus`, `Qwen3-Max`, `Qwen3-Coder-Next`, `Qwen3-Coder-Plus`, and `GLM-4.7`; `kimi-k3` → `kimi/kimi-k3`.
- **[Changed] Tencent Cloud removes Hy3 preview** (both TokenHub and TokenPlan).

### Encrypted Reasoning Persistence & Recovery

- **[Added] StatefulMarker persistence for encrypted reasoning**: `encrypted reasoning` / `redacted_thinking` persisted across turns; auto-restored when ThinkingPart is stripped.
- **[Changed] Responses historical message conversion refined**: `redactedData` preserved with priority; empty ThinkingPart no longer emits empty assistant messages.
- **[Fixed] Encrypted reasoning loss in historical messages**: VS Code 1.130+ ThinkingPart stripping broke reasoning replay; also fixed the `StreamReporter` metadata field name (`data` → `redactedData`).

### Debugging & Testing

- **[Added] HAR debugging navigation enhancements**: Added microsecond timestamps, sequence IDs, and status timestamps; HAR files can be opened directly from the status bar tooltip.
- **[Added] VS Code integration test pipeline**: Added `compile/typecheck/test:vscode` scripts, covering Responses / Anthropic reasoning restoration scenarios.

## [0.26.9] - 2026-07-27

### 新增

- **OpenAI Responses API 请求稳定化**：规范化工具调用参数的 JSON 键序并为历史消息生成稳定的调用 ID，减少多轮对话中的请求漂移，提升服务端缓存命中与工具调用稳定性。
- **Anthropic 缓存断点优化**：重新打断点前清理请求中的空白文本占位符与旧缓存标记，避免无效内容干扰缓存命中。

### 变更

- **OpenAI Responses API 处理流程重构**：原 `openaiResponsesHandler.ts`（约 1500 行）拆分为消息转换、请求构造、流式处理、流状态机等独立模块，Anthropic / OpenAI 相关预处理归类到各自子目录。
- **流式响应改为实时推送**：移除文本与思考缓冲层，降低首字延迟。
- **火山方舟模型阵容更新**：移除即将下线的 `DeepSeek-V3.2-251201`（EOS 2026-07-30）与 `GLM-4.7-251222`（EOS 2026-07-30）。
- **Codex CLI 优化**：相关文件归类到 `cli/` 目录，新增 3 分钟内存缓存避免短时重复拉取远端模型列表。

### 修复

- **MiniMax 状态栏每周限额不显示（[#257](https://github.com/VicBilibily/GCMP/issues/257)）**：Coding Plan 套餐下每周限额条始终不出现，已修复。

---

### Added

- **OpenAI Responses API request stabilization**: Canonicalizes JSON key order of tool-call arguments and generates stable IDs for historical messages, reducing request drift across multi-turn conversations to improve server-side cache hits and tool-call stability.
- **Anthropic cache breakpoint optimization**: Strips blank-text placeholders and stale cache markers before re-injecting breakpoints, preventing invalid content from interfering with cache hits.

### Changed

- **OpenAI Responses API pipeline refactor**: The original `openaiResponsesHandler.ts` (~1500 lines) is split into dedicated modules for message conversion, request building, stream processing, and stream state machine; Anthropic / OpenAI preprocessors are organized under their own subdirectories.
- **Streaming responses now push in real time**: Removed text and thinking buffer layers to reduce time-to-first-token.
- **Volcengine model lineup update**: Removed the soon-to-be-retired `DeepSeek-V3.2-251201` (EOS 2026-07-30) and `GLM-4.7-251222` (EOS 2026-07-30).
- **Codex CLI optimizations**: Related files reorganized under `cli/`; a 3-minute in-memory cache prevents repeatedly fetching the remote model list within a short window.

### Fixed

- **MiniMax status bar weekly quota not shown ([#257](https://github.com/VicBilibily/GCMP/issues/257))**: The weekly quota item never appeared under Coding Plan; fixed.

## [0.26.8] - 2026-07-24

### 新增

- **蚂蚁百灵 Ling-3.0-flash 接入**：AntLing 新增高性价比模型 `Ling-3.0-flash`（124B/5.1B 激活，原生 256K 上下文）。

---

### Added

- **AntLing Ling-3.0-flash access**: Added the cost-effective `Ling-3.0-flash` model (124B/5.1B activated, native 256K context).

## [0.26.7] - 2026-07-24

### 新增

- **Anthropic 缓存断点自动注入**：VS Code 1.130 起上游不再对第三方 vendor 模型下发 `cache_control`，导致 Anthropic 模型（尤其 Opus 4.x）缓存命中率骤降（[#314](https://github.com/VicBilibily/GCMP/issues/314)）。现按官方策略自动为请求注入缓存断点：优先给最后一个非延迟加载工具与 system 稳定前缀打断点，再按消息级规则补充，且单请求断点数不超过 4 个、不驱逐已有消息级断点。

### 修复

- **用量统计切换日期后视图数据错乱**：切换日期后再切换"小时/提供商/模型"视图会错误显示当日数据。
- **请求记录状态颜色不可区分**：进行中（ACTIVE）状态改为蓝色，与已取消（CANCEL）的灰色区分开。

---

### Added

- **Automatic Anthropic cache breakpoint injection**: Since VS Code 1.130, the upstream no longer sends `cache_control` for third-party vendor models, causing Anthropic models (especially Opus 4.x) cache hit rates to drop sharply ([#314](https://github.com/VicBilibily/GCMP/issues/314)). Cache breakpoints are now automatically injected per the official strategy: the last non-deferred tool and the stable system prefix are marked first, then message-level breakpoints are added, capped at 4 per request without evicting existing message-level breakpoints.

### Fixed

- **Usage stats view data mismatch after switching dates**: Switching the "Hours / Providers / Models" view after changing dates incorrectly showed today's data.
- **Indistinguishable request status colors**: The in-progress (ACTIVE) status is now blue, distinct from the gray CANCEL status.

## [0.26.6] - 2026-07-24

### 新增

- **火山方舟 Doubao-Seed-2.1-turbo 套餐接入**：CodingPlan / AgentPlan 双套餐新增 `Doubao-Seed-2.1-turbo`。

### 变更

- **火山方舟模型阵容更新**：CodingPlan / AgentPlan 移除 `Doubao-Seed-2.0-Code`、`Doubao-Seed-2.0-pro`、`Ark-Code-Latest`；CodingPlan 额外移除 `Doubao-Seed-Code`。

---

### Added

- **Volcengine Doubao-Seed-2.1-turbo plan access**: Added `Doubao-Seed-2.1-turbo` to both CodingPlan and AgentPlan.

### Changed

- **Volcengine model lineup updated**: CodingPlan / AgentPlan removed `Doubao-Seed-2.0-Code`, `Doubao-Seed-2.0-pro`, `Ark-Code-Latest`; CodingPlan additionally removed `Doubao-Seed-Code`.

## [0.26.5] - 2026-07-23

### 新增

- **请求分类器识别更多 Copilot 轻量辅助请求**：新增 `patch-healer`（apply_patch / edit_file 失败后的补丁修复）、`notebook-gen`（Notebook 大纲与单元格生成）、`mcp-setup`（MCP 服务器配置生成）、`tool-clustering`（虚拟工具聚类摘要）、`ai-evaluator`（AI 响应达标评估）五种请求类型，并补充 @workspace 代码搜索代理、Dev Container 配置、测试意图解析、code mapper 新文档生成等场景的前缀映射，这些子请求可正确关闭思考模式、避免被误判为主 Agent 对话。

### 变更

- **Kimi-K3 思考档位调整**：Moonshot、ClinePass、OpenCode Go、腾讯云、火山方舟渠道的 Kimi-K3 模型推理档位统一改为 `max / high / low`（移除 `none`，补齐 `high`），与官方最新支持的档位保持一致。

---

### Added

- **Request classifier recognizes more lightweight Copilot auxiliary requests**: Added five new request types — `patch-healer` (patch repair after failed apply_patch / edit_file), `notebook-gen` (Notebook outline and cell generation), `mcp-setup` (MCP server configuration), `tool-clustering` (virtual tool clustering summaries), and `ai-evaluator` (AI response criteria evaluation) — plus prefix mappings for the @workspace code search agent, Dev Container configuration, test intent parsing, and code mapper new-document generation. These sub-requests now correctly disable thinking mode instead of being misclassified as main agent conversations.

### Changed

- **Kimi-K3 reasoning effort tiers adjusted**: Kimi-K3 across Moonshot, ClinePass, OpenCode Go, Tencent Cloud, and Volcengine now uses unified `max / high / low` reasoning tiers (removed `none`, added `high`), matching the officially supported tiers.

## [0.26.4] - 2026-07-21

### 新增

- **1M 上下文模型新增 192K 窗口档位**：覆盖全部内置 provider 的 1M 模型；火山方舟按量版 `Doubao-Seed-Evolving` 同步补齐窗口选择。
- **128K 阶梯定价模型新增窗口选择**：dashscope `Qwen3-Max` / `Qwen3-Coder-Next` 与火山方舟 Doubao-Seed 系列（CodingPlan / AgentPlan / 按量）新增 128K 档，可锁定在 128K 以内避免触达高阶梯价。

### 变更

- **Grok 4.5 窗口档位调整**：原 200K 档调整为 256K / 192K 档（含 OpenCode Zen）。

---

### Added

- **192K window tier for 1M-context models**: Applied to all 1M models across built-in providers; Volcengine pay-as-you-go `Doubao-Seed-Evolving` also gains window selection.
- **Window selection for 128K-tiered pricing models**: DashScope `Qwen3-Max` / `Qwen3-Coder-Next` and Volcengine Doubao-Seed series (CodingPlan / AgentPlan / pay-as-you-go) now offer a 128K tier, locking usage below the 128K pricing threshold.

### Changed

- **Grok 4.5 window tiers adjusted**: The former 200K tier is replaced by 256K / 192K tiers (including OpenCode Zen).

## [0.26.3] - 2026-07-20

### 新增

- **原生工具配置支持透传 provider 特有选项**：`nativeToolConfig` 除 `type` 外不再限制固定字段，允许传入 provider 特有的额外选项（如 `x_search`、`remote_mcp`）并按原样透传至 Responses API 请求体；`web_search` 的 GCMP 内部字段仍转换为标准 API 格式（[#311](https://github.com/VicBilibily/GCMP/issues/311)）。
- **Grok 4.5 启用 web_search 原生工具**：Grok 4.5 模型开启原生联网搜索能力。

### 修复

- **Agents 窗体与普通窗口双主实例冲突**：Agents 窗体的 `globalState` 与普通窗口隔离，导致双方各自当选 Leader（[#310](https://github.com/VicBilibily/GCMP/issues/310)）。现改为 Agents 窗体不参与选举，通过临时目录下的 Leader 发现文件以纯客户端连接普通窗口的 IPC Server。

---

### Added

- **Native tool configs support provider-specific options**: `nativeToolConfig` no longer restricts fields beyond `type`; provider-specific extra options (e.g. `x_search`, `remote_mcp`) are passed through to the Responses API request body as-is, while GCMP's internal `web_search` fields are still converted to the standard API format ([#311](https://github.com/VicBilibily/GCMP/issues/311)).
- **Grok 4.5 enables the web_search native tool**: The Grok 4.5 model now has native web search enabled.

### Fixed

- **Duplicate leader instances across Agents window and editor windows**: The Agents window's `globalState` is isolated from regular windows, causing both sides to elect themselves as Leader ([#310](https://github.com/VicBilibily/GCMP/issues/310)). The Agents window no longer participates in the election and instead connects to the regular window's IPC server as a pure client via a leader discovery file in the temp directory.

## [0.26.2] - 2026-07-19

### 新增

- **ClinePass 新增 Kimi-K3 模型**：新增 `cline-pass/kimi-k3`，支持 1M 上下文、视觉理解与工具调用。
- **OpenCode Go 新增 Kimi-K3 模型**：新增 `kimi-k3-go`，支持 1M 上下文、视觉理解与工具调用。

---

### Added

- **ClinePass adds Kimi-K3 model**: Added `cline-pass/kimi-k3` with 1M context, vision input, and tool calling.
- **OpenCode Go adds Kimi-K3 model**: Added `kimi-k3-go` with 1M context, vision input, and tool calling.

## [0.26.1] - 2026-07-19

### 新增

- **阿里云百炼 Token Plan 个人版支持**：新增 `dashscope-token-personal` 密钥类型与配套模型接入。Token Plan 个人版与团队版共用接入点（OpenAI Responses / Anthropic 兼容协议），但使用相互独立的 `sk-sp-` 专属密钥，需在配置向导或 `gcmp.dashscope.setPersonalTokenPlanApiKey` 命令中单独设置。个人版首批接入 qwen3.8-max-preview、qwen3.7-max、qwen3.7-plus、qwen3.6-flash、glm-5.2、deepseek-v4-pro 六款文本模型。
- **新增 Qwen3.8-Max-Preview 预览旗舰模型**：Token Plan 团队版与个人版同步新增 `Qwen3.8-Max-Preview` 模型，支持视觉理解、思考模式与 `web_search` / `web_extractor` 原生工具调用（Responses API）。该模型当前仅限 Token Plan 套餐可用，套餐内调用以 Credits 统一计量，官方暂未公布按 Token 单价，因此暂不提供成本估算展示。

### 变更

- **Token Plan 密钥命名区分团队版与个人版**：原 `dashscope-token` 密钥在配置向导、命令标题与 Gist 同步显示名中统一标注为团队版（Team），避免与新增的个人版密钥混淆。
- **启用原生工具的模型移除思考开关**：百炼在注入 `web_search` / `web_extractor` 原生工具时不支持关闭思考，移除相关模型（按量计费 qwen3.7/qwen3.6/qwen3.5 系列及 Token Plan 对应模型）的 `thinking` 配置项，统一遵循服务端默认思考行为。

---

### Added

- **AliDashScope Token Plan (Personal) support**: Added the `dashscope-token-personal` key type with its own model set. Token Plan Personal shares the same endpoints as the Team edition (OpenAI Responses / Anthropic compatible protocols) but uses a separate `sk-sp-` dedicated key, configurable via the setup wizard or the `gcmp.dashscope.setPersonalTokenPlanApiKey` command. The first batch of Personal models includes qwen3.8-max-preview, qwen3.7-max, qwen3.7-plus, qwen3.6-flash, glm-5.2, and deepseek-v4-pro.
- **New Qwen3.8-Max-Preview flagship preview model**: Added `Qwen3.8-Max-Preview` to both Token Plan (Team) and Token Plan (Personal), with vision input, thinking mode, and native `web_search` / `web_extractor` tool calls (Responses API). The model is currently exclusive to Token Plan and billed in Credits; since no official per-token price is published yet, cost estimation is not shown for it.

### Changed

- **Token Plan key naming distinguishes Team and Personal editions**: The existing `dashscope-token` key is now labeled as Token Plan (Team) in the setup wizard, command titles, and Gist sync display names to avoid confusion with the new Personal key.
- **Removed thinking toggle for models with native tools**: Bailian does not support disabling thinking when native `web_search` / `web_extractor` tools are injected; removed the `thinking` option from affected models (pay-as-you-go qwen3.7/qwen3.6/qwen3.5 series and corresponding Token Plan models), deferring to the server's default thinking behavior.

## [0.26.0] - 2026-07-19

### Token 定价与成本估算

- **[新增] Token 定价与客户端成本估算**：支持通过内置模型配置和 `gcmp.providerOverrides.<provider>.models[].tokenPricing` / `gcmp.compatibleModels[].tokenPricing` 为模型配置输入、输出、缓存读取、缓存写入等 Token 定价，并按峰谷时段、服务等级（`serviceTier`）和上下文大小（`contextSizeMin`）应用不同价格。预估成本会内联显示在 Token 数量下方，状态栏、详情页和多日趋势页均可查看；新增 `formatCostBreakdownLog` 日志输出，便于个人参考与核对。
- **[新增] 双币种成本展示**：定价配置支持 USD/RMB 双币种并列，按模型原生结算币种标记展示；状态栏（中文环境）、详情页、侧边栏日期列表与会话记录、多日趋势页均支持成本双币显示，并新增 USD/RMB 货币切换视图。
- **[新增] 多日视图成本展示**：多日趋势页新增成本趋势折线图与成本卡片汇总，优化 Token 与成本格式化工具函数。
- **[新增] 增量 Token 预估**：基于上一轮 API 实际用量做增量预估，消除长上下文中累积估算误差。
- **[变更] 定价配置结构优化**：`pricing` 字段统一支持对象形式与数组简写，可直接表达输入、输出、缓存读取、缓存写入价格，并兼容现有对象配置。
- **[变更] 上下文阈值分档统一**：上下文定价阈值统一按 API 实际输入 Token（含缓存）判定。

### 多窗口跨实例协同

- **[新增] 跨实例状态同步**：新增 Leader/Follower 跨实例通信模块，基于本地 IPC 广播事件在多 VS Code 窗口间同步状态栏、实时指标、配置变更和 API Key 变更，IPC 不可用时自动降级到文件系统轮询；支持 Leader 卸任通知和推荐下一任 Leader，无缝切换主实例。Leader 实例串行化 stats 写盘并响应 Follower 的 `statsRefreshRequested` 委托，避免多实例并发覆盖，并辅以每分钟周期兜底刷新今日 stats；过期数据清理统一由 Leader 执行，状态栏可显示主/子实例角色标识。
- **[新增] CLI 凭证跨实例单点刷新**：多窗口下由 Leader 实例统一执行 CLI OAuth 令牌刷新并以原子写入更新凭证文件，Follower 通过跨实例委托等待刷新回执；委托超时后先重读凭证文件并检测 Leader 心跳，仅在 Leader 失联时才本地兜底刷新，避免 refresh_token 单次轮换被并发刷新作废。ChatGPT 状态栏用量查询同步接入该通道。

### 状态栏与用量展示

- **[新增] Kimi 加油包钱包查询**：月之暗面 Kimi 会员套餐的加油包（Top-up Wallet）余额查询与状态栏展示，支持查看加油包额度与到期时间。
- **[新增] ClinePass 用量查询状态栏**：新增 ClinePass 套餐周期剩余用量、重置时间和总利用率的状态栏展示。
- **[新增] 输出速度鲁棒统计与重置倒计时**：输出速度等实时指标改用基于 MAD 加权均值的鲁棒统计量剔除离群值，状态栏用量表新增套餐重置倒计时列。
- **[变更] 上下文窗口状态栏简化**：饼图图标直观反映当前会话上下文窗口占用比例（0/8 ~ 8/8），悬停即可查看模型名称、占用百分比、Token 用量和请求来源类型，移除了细分类别拆解与状态缓存。
- **[变更] Token 成本内联展示**：状态栏表格、详情页提供商统计表和最近请求记录中的 Token 数量下方内联显示预估成本，移除独立成本列，节省横向空间。
- **[变更] 状态栏表格列结构调整**：状态栏每日统计弹窗合并消耗 Tokens 列与成本列，简化表头为「输入(+缓存)+输出=消耗Tokens」，缓存命中与输入 Token 成本拆分展示；同步调整 Token 输入输出格式化并清理冗余的格式化工具函数。
- **[变更] 通用请求完成后统一触发状态栏延迟刷新**：所有提供商的模型请求完成后，统一通过 `TokenUsageStatusBar.triggerDelayedUpdate` 延迟刷新 Token 消耗展示，避免高频请求导致的频繁 I/O。

### 联网搜索与原生工具

- **[新增] 原生工具配置**：新增 `nativeTools` 配置项，支持向 OpenAI Responses API 注入内置工具（如 `web_search`、`web_extractor`）；与 `webSearchTool` 叠加注入，重复配置时以 `nativeTools` 为准；仅 `sdkMode=openai-responses` 生效，`anthropic` 模式仅取其中的 `web_search` 项。模型编辑器新增对应 JSON 配置字段与实时验证。
- **[新增] 联网搜索工具**：`webSearchTool` 从布尔值扩展为对象配置（`maxUses`/`allowedDomains`/`blockedDomains`/`userLocation`）；新增 `openai-responses` 模式下原生 `web_search` 工具注入与 `url_citation`/`web_search_call` 事件处理；模型编辑器新增 `webSearchToolConfig` JSON 配置字段与实时验证。为 Codex、火山引擎 GLM 系列模型默认启用联网搜索。

### 重试与错误处理

- **[新增] 错误重试分类器**：新增 `Codex` 和 `Responses API` 的 `rate_limits` / `snapshot_bootstrap` 等重试条件判定，覆盖限流和快照引导失败场景。
- **[修复] 永久性错误不再误入重试**：修复日/月硬配额耗尽、账单或套餐超限、请求超出模型上下文限制等永久性错误被误判为限流而反复重试的问题；无限重试模式（`maxAttempts=-1`）新增 30 分钟总时长兜底上限。
- **[修复] OpenAI 流式 keepalive 心跳过滤**：修复网关 keepalive 心跳事件在 `response.created` 之前进入 Responses SDK 流导致崩溃的问题。

### 调试可观测

- **[新增] HAR 请求录制**：新增 `gcmp.debug.captureHar` 与 `gcmp.debug.harRetentionCount` 调试设置，可在 `globalStorage/har/` 中记录 HTTP 请求与响应（HAR 1.2 格式），便于排查兼容性与网关问题。默认关闭，FIM/NES 补全、Gist 同步、CLI OAuth 刷新等敏感或高频请求默认跳过录制；敏感请求头、URL 查询参数及重定向 URL 中的凭据会自动脱敏。支持按时间间隔自动轮换并强制删除 2 小时前的旧文件，避免单个 HAR 文件无限增长。

### 模型与提供商配置

- **[变更] thinking 配置支持 effort 格式**：Anthropic 请求的 thinking 配置新增 `effort-none` 等 effort 形式支持，同步优化多模型定价与上下文阈值配置。
- **[变更] 上下文窗口与 Token 限配置优化**：内置提供商模型配置的 `maxInputTokens`/`maxOutputTokens` 上限调优，提升长上下文场景兼容性（[#269](https://github.com/VicBilibily/GCMP/issues/269)）。
- **[变更] Codex 模型列表仅使用 OAuth 凭证**：Codex 远端模型列表拉取移除手动 API Key 回退，统一使用 Codex CLI OAuth 凭证；无有效凭证时回退为内置预置模型列表。
- **[变更] 腾讯云付费模型与 DeepSeek 专用密钥配置移除**：腾讯云 TokenHub 渠道的付费模型和 DeepSeek 专用密钥配置已废弃，统一使用 TokenHub / Token Plan 密钥接入。

### 架构清理

- **[变更] 移除 Gemini SSE 实验性支持**：移除 `geminiHandler`/`geminiConverter`/`geminiType` 等实验性模块（约 2300 行）。

---

### Token Pricing & Cost Estimation

- **[Added] Token pricing & client cost estimation**: Supports configuring model pricing for input, output, cache-read, and cache-write tokens through built-in model configs and `gcmp.providerOverrides.<provider>.models[].tokenPricing` / `gcmp.compatibleModels[].tokenPricing`, with different prices applied by peak/off-peak tiers, `serviceTier`, and `contextSizeMin`. Estimated costs are shown inline below token counts across the status bar, details view, and multi-day trend view. Added `formatCostBreakdownLog` output for personal reference and verification.
- **[Added] Dual-currency cost display**: Pricing configs now support listing both USD and RMB, marked by each model's native settlement currency; costs are displayed in dual currencies across the status bar (in Chinese locale), details view, sidebar date list and session records, and multi-day trend view, with a new USD/RMB currency switch view.
- **[Added] Multi-day cost view**: Added cost trend line chart and cost card summary to the multi-day trend page; optimized token and cost formatting utilities.
- **[Added] Incremental token estimation**: Based on the previous request's actual API usage, eliminating cumulative estimation errors in long contexts.
- **[Changed] Pricing configuration structure optimized**: `pricing` now supports both object form and array shorthand, allowing direct expression of input, output, cache-read, and cache-write prices while remaining compatible with existing object configs.
- **[Changed] Unified context threshold tiers**: Context pricing thresholds are now uniformly determined by actual API input tokens (including cache).

### Multi-Window Cross-Instance Coordination

- **[Added] Cross-instance state sync**: New Leader/Follower inter-instance communication module that broadcasts events via local IPC across VS Code windows for status bar, live metrics, config changes, and API key changes, with automatic fallback to file-system polling when IPC is unavailable; supports leader resignation notification with next-leader nomination for seamless primary instance switching. The Leader instance serializes stats writes and handles Follower `statsRefreshRequested` delegations to prevent concurrent overwrites, with a per-minute periodic fallback refresh for today's stats; expired data cleanup is performed solely by the Leader, and the status bar can display leader/follower role badges.
- **[Added] Cross-instance single-point CLI credential refresh**: With multiple windows, the Leader instance uniformly performs CLI OAuth token refreshes and atomically writes credential files; Followers delegate refreshes via the inter-instance bus and wait for receipts. After a delegation timeout, credentials are re-read and the leader heartbeat is checked, falling back to local refresh only when the leader is unreachable — preventing concurrent refreshes from invalidating single-rotation refresh tokens. The ChatGPT status bar usage query now uses this channel.

### Status Bar & Usage Display

- **[Added] Kimi Top-up wallet query**: Balance query and status bar display for Kimi membership plan top-up wallets, showing credit balance and expiration time.
- **[Added] ClinePass usage status bar**: Displays ClinePass plan cycle remaining usage, reset time, and total utilization in the status bar.
- **[Added] Robust output-speed statistics & reset countdown**: Real-time metrics such as output speed now use robust statistics (MAD-weighted mean) to exclude outliers; the status bar usage table adds a plan reset countdown column.
- **[Changed] Simplified context status bar**: A pie-chart icon intuitively reflects the current session's context window usage ratio (0/8 ~ 8/8); hover to view model name, usage percentage, token count, and request source type; removed detailed category breakdown and status caching.
- **[Changed] Inline cost display in token cells**: Estimated costs are displayed inline below token counts in the status bar, provider stats table, and recent request records; removed standalone cost column to save horizontal space.
- **[Changed] Status bar table column restructure**: Merged the tokens and cost columns in the daily statistics popup into a simplified "Input(+Cache)+Output=Consumed" header; cache hit and input token costs are shown separately; also adjusted token input/output formatting and removed redundant formatting utilities.
- **[Changed] Unified delayed status bar refresh**: All provider model requests now trigger a delayed `TokenUsageStatusBar.triggerDelayedUpdate` refresh after completion, reducing frequent I/O from high-frequency requests.

### Web Search & Native Tools

- **[Added] Native tools config**: Added `nativeTools` config to inject built-in tools (e.g. `web_search`, `web_extractor`) into the OpenAI Responses API; stacked with `webSearchTool` and takes precedence on conflict; only effective when `sdkMode=openai-responses`, while `anthropic` mode only picks the `web_search` entry. Model editor adds the corresponding JSON config field with live validation.
- **[Added] Web search tool**: `webSearchTool` extended from boolean to object config (`maxUses`/`allowedDomains`/`blockedDomains`/`userLocation`); added native `web_search` tool injection and `url_citation`/`web_search_call` event handling under `openai-responses` mode; model editor adds `webSearchToolConfig` JSON field with live validation. Enabled web search by default for Codex and Volcengine GLM models.

### Retry & Error Handling

- **[Added] Retry classifier**: Added retry conditions for Codex `rate_limits` and Responses API `snapshot_bootstrap` scenarios, covering rate-limit and snapshot bootstrap failure cases.
- **[Fixed] Permanent errors no longer misclassified as retryable**: Fixed permanent errors — daily/monthly hard quota exhaustion, billing or plan limits, requests exceeding model context limits — being misclassified as rate limits and retried repeatedly; unlimited retry mode (`maxAttempts=-1`) now has a 30-minute total elapsed time safeguard.
- **[Fixed] OpenAI streaming keepalive heartbeat filtering**: Fixed gateway keepalive heartbeat events arriving before `response.created` and crashing the Responses SDK stream.

### Debugging Observability

- **[Added] HAR request capture**: Added `gcmp.debug.captureHar` and `gcmp.debug.harRetentionCount` debug settings to record HTTP requests and responses (HAR 1.2 format) under `globalStorage/har/`, making it easier to diagnose compatibility and gateway issues. Disabled by default; FIM/NES completions, Gist sync, and CLI OAuth refresh requests skip capture by default; credentials in sensitive headers, URL query parameters, and redirect URLs are automatically redacted. Supports time-interval-based auto-rotation with forced deletion of files older than 2 hours, preventing unbounded HAR file growth.

### Model & Provider Configuration

- **[Changed] Thinking config supports effort format**: Anthropic request thinking config now supports effort forms such as `effort-none`; also optimized pricing and context threshold configs for multiple models.
- **[Changed] Context window & token limit config optimized**: Bumped `maxInputTokens`/`maxOutputTokens` limits for built-in provider model configs to improve long-context compatibility ([#269](https://github.com/VicBilibily/GCMP/issues/269)).
- **[Changed] Codex model list uses OAuth credentials only**: Removed the manual API key fallback when fetching the remote Codex model list, unified to Codex CLI OAuth credentials; falls back to bundled preset models when no valid credential exists.
- **[Changed] Removed Tencent paid models & DeepSeek dedicated key config**: Deprecated Tencent Cloud TokenHub paid models and DeepSeek dedicated API key config; unified to TokenHub / Token Plan key access.

### Architecture Cleanup

- **[Changed] Removed Gemini SSE experimental support**: Removed `geminiHandler`/`geminiConverter`/`geminiType` and other experimental modules (~2300 lines).

## 历史版本（仅保留功能日志）

### 0.25.0 - 0.25.44 (2026-06-21 - 2026-07-17)

- **API Key 跨设备同步（GitHub Gist）**：新增 `gcmp.sync.configure` 命令，通过 GitHub Gist 加密同步 API Key；VS Code 内置 GitHub 认证，AES-256-GCM 加密、scrypt 派生密钥
- **视觉分析工具集**：新增 7 个视觉分析工具（`#gcmpUiToArtifact`、`#gcmpExtractTextFromScreenshot`、`#gcmpDiagnoseErrorScreenshot`、`#gcmpUnderstandTechnicalDiagram`、`#gcmpAnalyzeDataVisualization`、`#gcmpUiDiffCheck`、`#gcmpAnalyzeImage`），统一由 `gcmp.vision.model` 配置的多模态模型驱动，支持 GitHub Copilot 原生视觉模型
- **辅助工具模型设置面板**：新增 `GCMP: 设置辅助工具模型` 命令与可视化面板，统一配置 Commit / Vision / Utility / Copilot Agent 模型
- **请求来源分类（requestKind）**：新增请求分类器，区分主 Agent、终端命令、代码解释、搜索子 Agent 等请求类型，并据此控制子请求思考模式
- **重试机制强化**：新增提供商级重试配置覆盖（`gcmp.providerOverrides` 的 `retry` 配置，支持子 provider 独立策略）、502/503/504 服务端错误自动退避、重试状态栏进度提示、`maxAttempts` 上限放宽与无限重试（`-1`）模式
- **editTools 能力声明**：模型 `capabilities` 新增 `editTools` 字段，可声明模型偏好的编辑工具（`find-replace` / `multi-find-replace` / `code-rewrite` / `apply-patch`）
- **Compatible 提供商余额查询配置化**：支持通过 `gcmp.providerOverrides` 的 `usage` 字段声明式配置余额查询（JSON 路径提取、加减运算、成功条件判断）
- **FIM / NES 熔断器**：补全请求新增熔断器机制，连续失败达阈值自动暂停，冷却后半开探测恢复；修复编辑器失焦后仍持续请求与 `onDidChange` 自激请求风暴问题
- **新提供商**：LongCat（Anthropic 模式 Agentic 模型）、ClinePass（聚合平台）、讯飞星辰（Coding Plan / Token Plan 双套餐）、Grok（xAI 编程模型）
- **套餐接入扩展**：百度千帆 Token Plan 个人版/企业版、腾讯云 Token Plan 企业版、Codex 动态拉取可用模型列表（远端失败回退本地预置）
- **VS Code 1.129+ 兼容适配**：修复 stable 构建下 `languageModelSystem` / `chatProvider` / `contribLanguageModelToolSets` proposal 引发的提交消息生成、Vision 工具与提供商注册失败问题

### 0.23.0 - 0.24.16 (2026-05-30 - 2026-06-21)

- **Grok Build CLI (OAuth) 接入**：[#200](https://github.com/VicBilibily/GCMP/pull/200) 新增 `gcmp.grok` 提供商，支持通过 Grok Build OAuth 登录态访问 xAI 编程模型；新增 **grok-build-0.1** 模型，支持工具调用与图片输入
- **OpenCode 新提供商**：新增 `gcmp.opencode` 提供商，支持 Go 订阅与 Zen 按量付费，覆盖 GLM-5.1、Kimi-K2.6、DeepSeek-V4-Pro、MiniMax-M3 等 20+ 模型；流式模式后续切换为 `openai-sse`
- **全局代理链路统一**：新增 `gcmp.proxy`、`gcmp.tls.useSystemCertificates`，扩展提供商与模型级 `proxy` 覆盖；统一聊天请求、FIM/NES、模型发现、搜索、图片理解、状态栏查询、CLI OAuth 刷新及 MCP 客户端的代理感知链路
- **系统代理自动识别**：新增 Windows Registry 与 macOS `scutil` 系统代理检测，无显式配置时自动沿用系统设置
- **运行环境升级**：扩展运行基线升级至 Node.js `22.22.3`，`@vscode/chat-lib` 升级至 `0.47.0`
- **Charm Hyper 提供商**：[#218](https://github.com/VicBilibily/GCMP/pull/218) 新增 Charm Hyper 提供商，预置 DeepSeek-V4、Qwen3.6/3.7、GLM-5/5.1、Kimi-K2.5/2.6、MiniMax-M2.7 等 13 个模型
- **StepFun 提供商**：[#232](https://github.com/VicBilibily/GCMP/issues/232) 新增阶跃星辰开源大模型系列，内置 Step Reasoning 推理模式及 `#stepfunWebSearch` MCP 联网搜索工具
- **Ant Ling 提供商**：新增蚂蚁集团开源 MoE 架构大语言模型家族，采用 Anthropic 模式接入，预置 Ling-2.6-1T、Ling-2.6-flash、Ring-2.6-1T 三个模型
- **多日消耗分析视图**：用量面板新增「多日分析」标签页，支持跨日期趋势统计与可视化
- **工具上下文管理器（ToolContextManager）**：新增统一的管理器，通过 VS Code `setContext` 维护工具可用性上下文键，并实时监听 API Key 变更事件自动更新工具可见性
- **智能模型过滤**：提供商模型列表根据已配置的 API Key 过滤，仅展示可用模型
- **OpenRouter 网关 reasoning 字段兼容**：[#221](https://github.com/VicBilibily/GCMP/issues/221) 兼容 `delta.reasoning` / `delta.reasoning_details` 字段解析
- **重试开关**：新增 `gcmp.retry.enabled`（默认 `true`）
- **移除 Gemini CLI 提供商**：移除基于 CLI 认证的 Gemini 提供商支持

### 0.22.0 - 0.22.27 (2026-04-24 - 2026-05-30)

- **Commit 消息生成**：新增 System Role 提示词、默认优先读取暂存区并在生成后提示实际来源，同时加入 diff 过滤层与 `gcmp.commit.sensitiveFiles` 自定义敏感文件规则
- **Compatible 命名收敛**：界面与文档中的 `OpenAI / Anthropic Compatible` 统一简化为 `Compatible`
- **国际化与展示**：新增中英双语界面自动切换、ChatGPT 用量重置倒计时、Copilot 上下文窗口 `usage` 数据回传，并将默认 `gcmp.maxTokens` 提升至 `32000`
- **兼容层与流式稳定性**：修复 OpenAI `/responses` 在缺少 `Content-Type`、`response.failed` 事件上抛异常、JSON 错误体误判 SSE 等兼容性问题，并补充 `limit exceeded` 重试识别
- **工具调用与推理回放**：修复工具调用参数分片去重/解析问题；重构 reasoning replay 策略，修复多轮工具调用中的推理内容丢失及提交场景下关闭思考参数冲突

### 0.21.0 - 0.21.20 (2026-03-27 - 2026-04-23)

- **模型配置能力**：新增模型级 `thinking`、`reasoningEffort` 选项，允许手动调整模型思考模式及思考强度
- **请求重试机制**：统一由通用 Provider 处理自动重试，新增 `gcmp.retry.maxAttempts` 配置项

### 0.20.0 - 0.20.11 (2026-03-05 - 2026-03-23)

- **Codex CLI 认证支持**：新增 OpenAI Codex (Codex CLI) 提供商支持

### 0.19.0 - 0.19.17 (2026-02-12 - 2026-02-28)

- **功能优化**：重构 Token 统计缓存机制、优化状态栏统一显示剩余百分比、API Key 输入体验优化、Anthropic cache_control 兼容性改进

### 0.18.0 - 0.18.30 (2026-01-23 - 2026-02-11)

- **流解析处理架构**：重构整个 stream 流解析处理机制，统一通过 StreamReporter 进行输出管理
- **Token 统计**：新增完整的 Token 消耗统计系统，包括平均输出速度、首 Token 延迟、小时统计图表等可视化功能
- **MistralAI**：新增 MistralAI 提供商支持，支持 Codestral 系列模型 FIM/NES 代码补全功能

### 0.17.0 - 0.17.11 (2026-01-16 - 2026-01-22)

- **Commit 消息生成**：新增 AI 驱动的提交消息生成功能，支持多仓库场景和自动推断提交风格

### 0.16.0 - 0.16.26 (2025-12-29 - 2026-01-15)

- **Token消耗统计功能**：新增完整的 Token 消耗统计系统，包括文件日志记录、多格式支持、智能统计、状态栏显示、WebView 详细视图和数据管理
- **上下文窗口占用比例状态栏**：完善上下文窗口占用比例显示功能，新增各部分消息占用统计、图片 token 单独统计和环境信息占用单独列出
- **Gemini HTTP SSE 模式**(实验性)：新增纯 HTTP + SSE 流式实现，兼容第三方 Gemini 网关，支持自定义端点、鉴权、流式输出、思维链、工具调用、多模态输入等
- **OpenAI Responses API 支持**(实验性)：新增 `openai-responses` SDK 模式，支持思维链、Token 统计和缓存增量传递

### 0.14.0 - 0.15.23 (2025-11-30 - 2025-12-23)

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式
- **上下文窗口占用比例状态栏**：新增上下文窗口占用比例显示功能

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟、快手万擎等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
