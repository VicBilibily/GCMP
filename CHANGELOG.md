# 更新日志

本文档记录了 GCMP (AI Chat Models) 扩展的最近主要更改。

## [0.29.3] - 2026-10-25

### 修复

- **远程统计与维护**：修复远程窗口可能持续显示统计加载中的问题，启动时主动刷新当日统计；余额查询、统计对账、元数据刷新和日志保留清理不再依赖 Leader 调度。
- **元数据缓存一致性**：改进并发刷新时的缓存合并与写入，避免过期数据覆盖较新缓存，并防止不同来源的旧数据导致 CLI 版本信息回退。
- **元数据生命周期**：扩展清理开始时即停止元数据刷新，使失效的命令和异步响应不再继续写入缓存或更新已释放的提供商。

### 变更

- **远程窗口兼容模式**：SSH、WSL、Dev Container 等远程扩展宿主自动使用兼容模式，不参与 Leader 选举及 IPC/文件协调；限流和认证刷新由各宿主独立处理，状态栏使用专用图标和兼容模式提示进行区分，本地窗口行为保持不变。

---

### Fixed

- **Remote Statistics and Maintenance**: Fixed remote windows potentially remaining stuck loading statistics and added a startup refresh of today's statistics. Balance queries, statistics reconciliation, metadata refreshes, and retention cleanup no longer depend on Leader scheduling.
- **Metadata Cache Consistency**: Improved cache merging and writes during concurrent refreshes to prevent stale data from overwriting newer caches and older data from different sources from downgrading cached CLI versions.
- **Metadata Lifecycle**: Metadata refreshes now stop at the start of extension cleanup, preventing invalidated commands and asynchronous responses from continuing to write caches or update disposed providers.

### Changed

- **Remote Window Compatibility Mode**: Remote extension hosts such as SSH, WSL, and Dev Containers automatically use compatibility mode without participating in Leader election or IPC/file coordination. Each host handles rate limiting and authentication refresh independently, with a dedicated status bar icon and compatibility-mode tooltip. Local window behavior is unchanged.

## [0.29.2] - 2026-10-21

### 新增

- **请求余额与额度快照**：在请求实际派发时记录所用凭据对应的余额或剩余额度，在 Key 标签旁展示摘要，悬停或聚焦可查看明细；支持原生提供商及 Compatible 多项查询结果，并可离线查看历史快照，按当前界面语言展示。未保存快照的旧请求不会使用当前额度回填。

### 修复

- **额度缓存与跨窗口同步**：完善多 Key 额度缓存的时间与归属校验，保留各项真实查询时间，防止旧结果覆盖较新数据；忽略无效或未来的同步时间戳，避免后续正常更新被阻塞。

### 变更

- **统计同步与自动刷新**：状态栏、用量详情和多日分析增加周期校正，改善通知遗漏、主实例交接、详情读取失败及慢查询后的刷新恢复，并减少稳定历史统计的重复读取。
- **余额刷新调度**：请求完成后通知状态栏进行受限后台刷新，按提供商合并通知，默认延迟 2 秒、调度间隔至少 30 秒，冷却期内的新通知保留一次尾部刷新；周期和手动刷新继续生效，刷新结果不会回填已记录的请求快照。

---

### Added

- **Request balance and quota snapshots**: Records the balance or remaining quota associated with the credentials actually used when a request is dispatched. Summaries appear beside the key label, with details available on hover or focus. Supports native providers and multiple Compatible query results, offline history viewing, and the current UI language. Older requests without snapshots are not backfilled with current quota values.

### Fixed

- **Quota caching and cross-window synchronization**: Improved credential and timestamp validation for multi-key quota caches, preserving each query's original completion time and preventing older results from replacing newer data. Invalid or future synchronization timestamps are ignored so they cannot block subsequent valid updates.

### Changed

- **Statistics synchronization and automatic refresh**: Added periodic reconciliation for status bars, usage details, and multi-day analysis, improving refresh recovery after missed notifications, Leader handoff, detail read failures, and slow queries while reducing repeated reads of unchanged historical statistics.
- **Balance refresh scheduling**: Completed requests notify the status bar to schedule rate-limited background refreshes. Notifications are coalesced per provider, with a default 2-second delay, at least 30 seconds between scheduled refreshes, and one trailing refresh for notifications received during cooldown. Periodic and manual refreshes remain available, and refreshed values never overwrite recorded request snapshots.

## [0.29.1] - 2026-10-20

### 新增

- **实验性 Responses WebSocket 通道**：OpenAI Responses 模式新增可选 WebSocket 传输，通过 `useWebSocket` 启用，默认关闭，支持连接复用、多轮上下文续传与工具调用；模型编辑器和 JSON 设置同步提供配置与校验。
- **DeepSeek 网页搜索**：新增独立 `#deepseekWebSearch` 工具，使用 DeepSeek API Key 搜索网页，支持结果数量、地域及正文获取设置。

### 修复

- **思考内容与上下文回放**：保留带签名的空思考块，完善 Anthropic / Gemini 历史消息及加密推理的跨轮回放；归一 SDK 回放中的加密推理 ID，避免上下文续传不匹配。
- **SDK 请求与会话统计**：完善 SDK 请求分类、用量缓存与回放缓存，增强会话恢复的隔离，减少不同会话之间的关联干扰。
- **流式请求中断与资源释放**：完善取消、异常终态、重试判定和传输清理，避免清理失败覆盖原始请求错误，并限制会话事件文件的并发读取。

### 变更

- **HAR 请求诊断**：增强请求生命周期与传输恢复诊断，完善 HAR 录制的关闭、脱敏和错误处理，便于排查流式请求异常。

---

### Added

- **Experimental Responses WebSocket channel**: OpenAI Responses mode now supports optional WebSocket transport via `useWebSocket`, disabled by default, with connection reuse, multi-turn context continuation, and tool calls. Configuration and validation are available in the model editor and JSON settings.
- **DeepSeek web search**: Added the standalone `#deepseekWebSearch` tool, using a DeepSeek API key to search the web with configurable result counts, localization, and full-content retrieval.

### Fixed

- **Thinking and context replay**: Preserved signed empty thinking blocks and improved Anthropic / Gemini history replay and encrypted reasoning across turns. Encrypted reasoning IDs are normalized in SDK replay to prevent context continuation mismatches.
- **SDK requests and session statistics**: Improved SDK request classification, usage and replay caching, and session recovery isolation to reduce cross-session association interference.
- **Stream interruption and resource cleanup**: Improved cancellation, error finalization, retry decisions, and transport cleanup. Cleanup failures no longer obscure the original request error, and concurrent reads of session event files are bounded.

### Changed

- **HAR request diagnostics**: Improved request lifecycle and transport recovery diagnostics, along with HAR recording shutdown, redaction, and error handling for troubleshooting streaming failures.

## [0.29.0] - 2026-10-15

### 新增

- **Gemini 原生通道**：新增 `gemini` SSE 模式，支持 GenerateContent 流式请求、`v1` / `v1beta` 接入点、工具调用、多模态消息与思考签名回放，并统一取消、终态和用量处理。
- **API Key 自动故障切换**：配置集可按请求失败自动切换可用凭据，支持失败凭据临时隔离、轮次级粘滞与跨窗口状态协调，减少同轮请求反复切换 Key。
- **加权负载均衡**：配置集新增负载均衡与权重设置，由主实例统一分配凭据，支持子代理子会话分配、凭据租约和主实例交接；无可用主实例时回退到当前可用凭据。
- **多 Key 配额与请求身份**：状态栏集中展示多套凭据的配额与余额，用量面板记录请求实际使用的 Key 身份和配置名，便于核对各配置的消耗。
- **多额度用量查询**：Compatible 用量查询支持数组项拆分、多额度命名、`[*]` 数值汇总，以及展示名称的字段路径、前缀和后缀配置。
- **机器级代理覆盖**：新增 `gcmp.machineOverrides`，可为当前机器单独配置提供商或模型代理，不随配置同步影响其他设备。

### 变更

- **FIM / NES 改为可选安装**：代码补全拆分至 `vicanent.gcmp-fim-nes`，不再包含在主扩展中，也不会自动安装。旧用户如需继续使用补全，须在扩展市场手动安装子扩展；原有补全设置和主扩展 API Key 可继续使用，聊天功能不依赖补全扩展。
- **启动引导与辅助偏好**：不再覆盖 VS Code 或其他扩展的默认设置；辅助模型与 Local Agent 偏好仅在用户确认后写入全局配置。辅助偏好面板新增聊天模式设置，已有明确全局偏好时不再显示对应启动提示。
- **跨窗口用量与统计体验**：按需定向查询用量明细，优先显示轻量统计并预取相邻页面，减少重复读取和窗口间缓存副本；增强历史统计恢复、持久化与主实例交接的一致性。启动时尚无已知主实例可从本地读取当日摘要，收到权威快照后接管展示。
- **请求分类与子代理思考**：统一 SDK 与 Copilot Chat 的请求作用域和分类元数据，子代理请求保留显式思考配置与默认思考强度。
- **请求字段移除**：自定义请求头中的 `null` 可移除同名内置头；`extraBody` 中的 `null` 在自动参数注入后生效，可用于移除自动添加的同名字段。
- **服务等级与模型缓存**：扩充 OpenAI 官方服务等级配置，支持 `fast` / `ultrafast`；模型信息缓存改为进程内复用，减少启动等待与重复构建，并提高远程元数据刷新频率。
- **安装要求**：主扩展与补全扩展均要求 VS Code 1.138.0 或更高版本。

### 移除

- **上下文占用状态栏**：移除上下文窗口占用比例状态栏，保留请求 Token 增量预估、限流与用量统计。
- **百炼 MCP 搜索工具**：移除内置 DashScope MCP 联网搜索工具；其他提供商搜索工具和模型自身的联网搜索能力不受此项移除影响。

---

### Added

- **Native Gemini channel**: Added the `gemini` SSE mode for streaming GenerateContent requests, `v1` / `v1beta` endpoints, tool calls, multimodal messages, and thought-signature replay, with unified cancellation, terminal state, and usage handling.
- **Automatic API key failover**: Configuration sets can switch credentials after request failures, with temporary credential quarantine, turn-level stickiness, and cross-window coordination to avoid repeated key changes within a turn.
- **Weighted load balancing**: Configuration sets support weighted credential allocation coordinated by the Leader, including subagent-session assignment, credential leases, and Leader handoff. Requests fall back to the current available credentials when no Leader is available.
- **Multi-key quotas and request identity**: Status bars consolidate quotas and balances across credentials. Usage records include the actual key identity and configuration name used by each request.
- **Multiple usage entries**: Compatible usage queries support array-based quota entries, named quotas, `[*]` numeric aggregation, and display names configured with field paths, prefixes, and suffixes.
- **Machine-specific proxy overrides**: Added `gcmp.machineOverrides` for provider-level or model-level proxies on the current machine without affecting other devices through configuration sync.

### Changed

- **Optional FIM / NES installation**: Completion moved to `vicanent.gcmp-fim-nes`; it is no longer bundled with the main extension or installed automatically. Existing users must manually install the companion from the Marketplace to continue using completion. Existing completion settings and main-extension API keys can be reused, and chat does not depend on the companion.
- **Startup guidance and auxiliary preferences**: Defaults owned by VS Code or other extensions are no longer overridden. Utility model and Local Agent preferences are saved globally only after confirmation. Auxiliary Preferences now includes chat mode settings, and explicit global preferences suppress the corresponding startup prompt.
- **Cross-window usage and statistics**: Usage details are queried on demand through targeted responses, with lightweight summaries and neighboring-page prefetch to reduce repeated reads and duplicate caches. Historical statistics recovery, persistence, and Leader handoff are more consistent. On startup without a known Leader, the daily summary can be read locally until an authoritative snapshot takes over.
- **Request classification and subagent thinking**: SDK and Copilot Chat requests share consistent scope and classification metadata. Subagent requests preserve explicit thinking settings and default reasoning effort.
- **Request field removal**: `null` custom headers can remove matching built-in headers. `null` fields in `extraBody` are applied after automatic parameter injection to remove matching generated fields.
- **Service tiers and model caching**: Expanded official OpenAI service tier settings with `fast` / `ultrafast`. Model information is cached and reused in-process to reduce startup waits and repeated builds, with more frequent remote metadata refreshes.
- **Installation requirements**: Both the main and completion extensions require VS Code 1.138.0 or later.

### Removed

- **Context usage status bar**: Removed the context-window usage percentage status bar while retaining incremental request token estimates, rate limiting, and usage statistics.
- **DashScope MCP search tool**: Removed the built-in DashScope MCP web search tool. Other providers' search tools and model-native web search capabilities are unaffected by this removal.

## [0.28.4] - 2026-09-19

### 新增

- **用量查询计算字段支持嵌套子表达式**：Compatible 用量查询配置的计算字段（`sum` / `subtract` / `multiply` / `divide`）的 `paths` 现支持嵌套计算字段对象，子表达式先行计算再参与外层运算，可实现 `(总额 - 已用) / 500000` 这类余额换算；`gcmp-settings` JSON Schema 同步更新。
- **余额状态栏警告阈值**：余额状态栏默认在可用余额不高于 20 时显示黄色背景，负余额显示红色背景；可通过 `gcmp.providerOverrides.<provider>.balanceWarning` 为各提供商单独覆盖警告阈值。 [#415](https://github.com/VicBilibily/GCMP/issues/415)

### 修复

- **Kimi 新会员体系额度查询**：适配 Kimi 2026-09 新会员体系，额度接口仅返回 5 小时与月度限额（`limit_month_code`）时不再误报"未获取到剩余额度数据"；额度摘要按来源显示"每周额度"或"每月额度"；同时兼容旧 `usage` / `limits` 字段缺失或条目残缺的情况。

---

### Added

- **Nested sub-expressions in usage computed fields**: computed fields (`sum` / `subtract` / `multiply` / `divide`) in Compatible usage query configs now accept nested computed-field objects in `paths`; inner expressions are evaluated before the outer operation, enabling conversions like `(total - used) / 500000`. The `gcmp-settings` JSON Schema was updated accordingly.
- **Balance status-bar warning thresholds**: balance status bars now use a yellow background when the available balance is at or below 20 by default, and a red background for negative balances; `gcmp.providerOverrides.<provider>.balanceWarning` can override the warning threshold per provider. [#415](https://github.com/VicBilibily/GCMP/issues/415)

### Fixed

- **Kimi quota query for the new membership system**: adapted to Kimi's 2026-09 membership, where the usage API returns only 5-hour and monthly limits (`limit_month_code`); these accounts no longer report "no remaining quota data". The quota summary is labeled "Weekly quota" or "Monthly quota" based on its source. The parser also tolerates missing or malformed legacy `usage` / `limits` fields.

## [0.28.3] - 2026-09-16

### 新增

- **阿里云百炼接入点切换（国内站 / 国际站）**：新增 `GCMP: 设置 阿里云百炼 接入点` 命令与 `gcmp.dashscope.endpoint` 设置（`cn-beijing` / `ap-southeast-1`），配置向导菜单内亦可切换；对所有百炼模型（标准、Coding Plan、Token Plan）生效，仅替换请求主机（`dashscope.aliyuncs.com` → `dashscope-intl.aliyuncs.com`、`coding.dashscope.aliyuncs.com` → `coding-intl.dashscope.aliyuncs.com`、`token-plan.cn-beijing.maas.aliyuncs.com` → `token-plan.ap-southeast-1.maas.aliyuncs.com`），路径保持不变；DashScope MCP 联网搜索工具同步跟随接入点。

### 变更

- **百炼 Qwen3.8 系列切换至 OpenAI Responses 兼容协议**：DashScope 渠道的 Qwen3.8 Max / Flash（标准、Token Plan 与个人 Token Plan）请求协议由 Anthropic 兼容切换为 OpenAI Responses 兼容，模型自带的 `web_search` 联网搜索随之恢复可用；使用自带搜索时建议在工具选择中关闭内置 `gcmp_dashscopeWebSearch` 工具，避免重复计费。 [#397](https://github.com/VicBilibily/GCMP/issues/397)

---

### Added

- **Alibaba Cloud DashScope endpoint switch (China / International)**: added the `GCMP: Set DashScope Endpoint` command and the `gcmp.dashscope.endpoint` setting (`cn-beijing` / `ap-southeast-1`), also available from the configuration wizard menu; it applies to every DashScope model (standard, Coding Plan and Token Plan) by replacing only the request host (`dashscope.aliyuncs.com` → `dashscope-intl.aliyuncs.com`, `coding.dashscope.aliyuncs.com` → `coding-intl.dashscope.aliyuncs.com`, `token-plan.cn-beijing.maas.aliyuncs.com` → `token-plan.ap-southeast-1.maas.aliyuncs.com`) while keeping paths unchanged; the DashScope MCP web search tool follows the same endpoint.

### Changed

- **DashScope Qwen3.8 series switched to the OpenAI Responses-compatible API**: Qwen3.8 Max / Flash on DashScope (standard, Token Plan and personal Token Plan) now use the OpenAI Responses-compatible protocol instead of the Anthropic-compatible one, restoring the models' built-in `web_search`; when using built-in search, disable the bundled `gcmp_dashscopeWebSearch` tool in the tool picker to avoid duplicate charges. [#397](https://github.com/VicBilibily/GCMP/issues/397)

## [0.28.2] - 2026-09-14

### 修复

- **远程模型元数据配置兼容性**：内置模型配置的 `baseUrl`、`endpoint` 与 `provider` 改按内置白名单校验，允许同一主机的多协议接入点正常切换。
- **自定义请求头与会话占位符**：Compatible 模型及各 SDK 通道支持在自定义请求头和 `extraBody` 中使用 `${SESSIONID}` 占位符，并统一完成会话 ID 替换。
- **远程元数据生成兼容性**：修复配置生成脚本读取带 UTF-8 BOM 的 JSON 文件时解析失败的问题。
- **OpenAI 兼容流正文重复输出**：修复部分网关同时返回 `delta` 与 `message` 时，OpenAI 模式因 SDK 快照字段别名导致正文分片被重复上报的问题。 [#407](https://github.com/VicBilibily/GCMP/issues/407)

---

### Fixed

- **Remote model metadata compatibility**: Built-in model configuration now validates `baseUrl`, `endpoint`, and `provider` against internal allowlists, allowing protocol switching between endpoints on the same host.
- **Custom headers and session placeholders**: Compatible models and SDK channels now support `${SESSIONID}` in custom headers and `extraBody`, with session ID substitution applied consistently.
- **Remote metadata generation compatibility**: Fixed configuration generation failures when reading JSON files containing a UTF-8 BOM.
- **Duplicate text in OpenAI-compatible streams**: Fixed duplicated streamed text in OpenAI mode when some gateways return both `delta` and `message`, causing SDK snapshot field aliasing to report the same content twice. [#407](https://github.com/VicBilibily/GCMP/issues/407)

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

- **NES 代码补全**：新增 Next Edit Suggestions (NES) 代码补全功能，整合 FIM 和 NES 两种模式，现由可选补全扩展提供

### 0.9.0 - 0.13.6 (2025-10-29 - 2025-11-29)

- **核心架构演进**：新增 `OpenAI / Anthropic Compatible` Provider，支持 `extraBody` 和自定义 Header

### 早期版本 (0.1.0 - 0.8.2)

早期版本实现了扩展的核心功能和基础架构，包括：多提供商支持（智谱AI、MoonshotAI、DeepSeek 等）、国内云厂商支持（阿里云百炼、火山方舟等）、联网搜索、编辑工具优化、配置系统、Token 计算、多 SDK 支持、思维链输出、兼容模式支持、自动重试机制等
