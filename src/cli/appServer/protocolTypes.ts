/*---------------------------------------------------------------------------------------------
 *  Codex App Server 协议类型（vendored 子集）
 *  来源：codex-cli 0.153.4 `codex app-server generate-ts`（ts-rs 生成，v2 schema），
 *  经 PoC-1~8 实测校准（discuss/poc/codex-app-server/）。
 *  仅保留 GCMP 用到的方法/通知/反向请求类型；未列入的字段按未知数据处理。
 *--------------------------------------------------------------------------------------------*/

/** 任意 JSON 值（serde_json::Value 对应物） */
export type JsonValue = unknown;

// ===== 握手 =====

export interface ClientInfo {
    name: string;
    title: string | null;
    version: string;
}

/** 客户端能力协商（initialize） */
export interface InitializeCapabilities {
    /** 启用实验性方法/字段 */
    experimentalApi: boolean;
    /** 按方法名屏蔽不需要的通知 */
    optOutNotificationMethods?: string[] | null;
}

export interface InitializeParams {
    clientInfo: ClientInfo;
    capabilities: InitializeCapabilities | null;
}

export interface InitializeResponse {
    userAgent: string;
    codexHome: string;
    platformFamily: string;
    platformOs: string;
}

// ===== 账户与额度 =====

export type PlanType = string;

export type Account =
    | { type: 'apiKey' }
    | { type: 'chatgpt'; email: string | null; planType: PlanType }
    | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean };

export interface GetAccountResponse {
    account: Account | null;
    requiresOpenaiAuth: boolean;
}

/** 速率限制窗口（注意：分钟制，区别于 direct HTTP 的秒制 limit_window_seconds） */
export interface AppServerRateLimitWindow {
    usedPercent: number;
    windowDurationMins: number | null;
    /** 重置时间戳（秒） */
    resetsAt: number | null;
}

export interface CreditsSnapshot {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
}

export interface RateLimitSnapshot {
    limitId: string | null;
    limitName: string | null;
    primary: AppServerRateLimitWindow | null;
    secondary: AppServerRateLimitWindow | null;
    credits: CreditsSnapshot | null;
    individualLimit: unknown | null;
    spendControlReached: boolean | null;
    planType: PlanType | null;
    rateLimitReachedType: unknown | null;
}

export interface GetAccountRateLimitsResponse {
    /** 兼容单桶视图 */
    rateLimits: RateLimitSnapshot;
    /** 按 limitId 的多桶视图（如 codex、codex_bengalfox） */
    rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
    rateLimitResetCredits: unknown | null;
    accountId: string | null;
    rateLimitUpsell: JsonValue | null;
}

/** account/rateLimits/updated 通知载荷（turn 完成后服务端主动推送） */
export interface AccountRateLimitsUpdatedNotification {
    rateLimits: RateLimitSnapshot;
}

// ===== 模型发现 =====

export type ReasoningEffort = string;

export interface ReasoningEffortOption {
    reasoningEffort: ReasoningEffort;
    description: string;
}

export type InputModality = 'text' | 'image' | 'audio';

export interface ModelServiceTier {
    id: string;
    name: string;
    description: string;
}

export interface AppServerModel {
    id: string;
    model: string;
    displayName: string;
    description: string;
    modelSpecialty: string | null;
    hidden: boolean;
    supportedReasoningEfforts: ReasoningEffortOption[];
    defaultReasoningEffort: ReasoningEffort;
    inputModalities: InputModality[];
    serviceTiers: ModelServiceTier[];
    defaultServiceTier: string | null;
    isDefault: boolean;
}

export interface ModelListResponse {
    data: AppServerModel[];
    nextCursor: string | null;
}

// ===== Thread / Turn =====

export type AskForApproval = 'untrusted' | 'on-request' | 'never' | { granular: unknown };

/** 沙箱模式（kebab-case 枚举，PoC 实测） */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ThreadStatus =
    | { type: 'notLoaded' }
    | { type: 'idle' }
    | { type: 'systemError' }
    | { type: 'active'; activeFlags: string[] };

export interface Thread {
    /** Codex 生成的 UUIDv7 */
    id: string;
    ephemeral: boolean;
    modelProvider: string;
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    createdAt: number;
    updatedAt: number;
    status: ThreadStatus;
    cwd: string;
    source: unknown;
    name: string | null;
    /** 仅 thread/resume、thread/rollback、thread/fork、thread/read(includeTurns) 时填充 */
    turns: Turn[];
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
    message: string;
    codexErrorInfo: unknown | null;
    additionalDetails: string | null;
    misalignment: unknown | null;
}

export type TurnItemsView = 'notLoaded' | 'summary' | 'full';

export interface Turn {
    /** Codex 生成的 UUIDv7 */
    id: string;
    items: ThreadItem[];
    itemsView: TurnItemsView;
    status: TurnStatus;
    error: TurnError | null;
    startedAt: number | null;
    completedAt: number | null;
    durationMs: number | null;
}

/** ThreadItem 相关变体（GCMP 消费子集）；未识别变体按 unknown 透传 */
export type ThreadItem =
    | { type: 'userMessage'; id: string; clientId: string | null; content: UserInput[] }
    | { type: 'agentMessage'; id: string; text: string; phase: string | null }
    | { type: 'reasoning'; id: string; summary: string[]; content: string[] }
    | { type: 'plan'; id: string; text: string }
    | {
          type: 'dynamicToolCall';
          id: string;
          namespace: string | null;
          tool: string;
          arguments: JsonValue;
          status: 'inProgress' | 'completed' | 'failed' | 'declined' | string;
          contentItems: DynamicToolCallOutputContentItem[] | null;
          success: boolean | null;
          durationMs: number | null;
      }
    | { type: 'functionCallOutput'; id: string; name: string; namespace: string | null; output: unknown }
    | { type: 'commandExecution'; id: string; command: string; status: string; aggregatedOutput: string | null }
    | { type: string; id?: string };

export interface ThreadStartParams {
    model?: string | null;
    cwd?: string | null;
    approvalPolicy?: AskForApproval | null;
    sandbox?: SandboxMode | null;
    config?: Record<string, JsonValue> | null;
    developerInstructions?: string | null;
    ephemeral?: boolean | null;
    /**
     * 注册 Dynamic Tools（0.153.4 实测透传生效；ts-rs 导出类型未暴露此字段）。
     * 仅在线程创建时注册，turn 级不可变更。
     */
    dynamicTools?: DynamicToolSpec[];
}

export interface ThreadStartResponse {
    thread: Thread;
    model: string;
    modelProvider: string;
}

export interface ThreadResumeParams {
    threadId: string;
    model?: string | null;
    approvalPolicy?: AskForApproval | null;
    sandbox?: SandboxMode | null;
    developerInstructions?: string | null;
    /** true 时仅返回元数据，不填充 thread.turns（配 thread/turns/list 分页） */
    excludeTurns?: boolean;
}

export interface ThreadResumeResponse extends ThreadStartResponse {
    turnsBackwardsCursor: string | null;
    itemsBackwardsCursor: string | null;
}

/** thread/revert：把持久历史替换为 beforeTurnId 之前的前缀 */
export interface ThreadRevertParams {
    threadId: string;
    beforeTurnId: string;
}

export interface ThreadArchiveParams {
    threadId: string;
}

/** thread/inject_items：追加原始 Responses API ResponseItem 作为模型可见历史 */
export interface ThreadInjectItemsParams {
    threadId: string;
    items: JsonValue[];
}

export interface ThreadItemsListParams {
    threadId: string;
    turnId?: string | null;
    cursor?: string | null;
    limit?: number | null;
    sortDirection?: 'asc' | 'desc' | null;
}

export interface ThreadItemsListResponse {
    data: Array<{ id?: string; turnId?: string; type?: string }>;
    nextCursor: string | null;
    backwardsCursor: string | null;
}

export interface ThreadTurnsListParams {
    threadId: string;
    cursor?: string | null;
    limit?: number | null;
    sortDirection?: 'asc' | 'desc' | null;
    itemsView?: TurnItemsView | null;
}

export interface ThreadTurnsListResponse {
    data: Turn[];
    nextCursor: string | null;
    backwardsCursor: string | null;
}

// ===== 用户输入（turn/start.input） =====

export type UserInput =
    | { type: 'text'; text: string; text_elements?: unknown[] }
    | { type: 'image'; detail?: string; url: string }
    | { type: 'localImage'; detail?: string; path: string }
    | { type: 'audio'; url: string }
    | { type: 'localAudio'; path: string };

export interface TurnStartParams {
    threadId: string;
    input: UserInput[];
    model?: string | null;
    effort?: ReasoningEffort | null;
    /** 推理摘要（子请求可传 none 关闭） */
    summary?: string | null;
    outputSchema?: JsonValue | null;
}

export interface TurnStartResponse {
    turn: Turn;
}

export interface TurnInterruptParams {
    threadId: string;
    turnId: string;
}

// ===== Dynamic Tools =====

export type DynamicToolCallOutputContentItem =
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
    | { type: 'inputAudio'; audioUrl: string };

export interface DynamicToolFunctionSpec {
    type: 'function';
    name: string;
    description: string;
    inputSchema: JsonValue;
    deferLoading?: boolean;
}

export type DynamicToolSpec =
    | DynamicToolFunctionSpec
    | { type: 'namespace'; name: string; description: string; tools: unknown[] };

/** 服务端反向请求 item/tool/call 的参数 */
export interface DynamicToolCallParams {
    threadId: string;
    turnId: string;
    callId: string;
    namespace: string | null;
    tool: string;
    arguments: JsonValue;
}

export interface DynamicToolCallResponse {
    contentItems: DynamicToolCallOutputContentItem[];
    success: boolean;
}

// ===== 通知载荷 =====

export interface TurnStartedNotification {
    threadId: string;
    turn: Turn;
}

export interface TurnCompletedNotification {
    threadId: string;
    turn: Turn;
}

export interface ItemStartedNotification {
    item: ThreadItem;
    threadId: string;
    turnId: string;
    startedAtMs: number;
}

export interface ItemCompletedNotification {
    item: ThreadItem;
    threadId: string;
    turnId: string;
    completedAtMs: number;
}

export interface AgentMessageDeltaNotification {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
}

export interface ReasoningTextDeltaNotification {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    contentIndex: number;
}

export interface ReasoningSummaryTextDeltaNotification {
    threadId: string;
    turnId: string;
    itemId: string;
    delta: string;
    summaryIndex: number;
}

export interface TokenUsageBreakdown {
    totalTokens: number;
    inputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
}

export interface ThreadTokenUsageUpdatedNotification {
    threadId: string;
    turnId: string;
    tokenUsage: ThreadTokenUsage;
}

// ===== JSON-RPC 帧 =====

export interface JsonRpcErrorObject {
    code: number;
    message: string;
    data?: unknown;
}

/** 客户端请求帧；无参方法（如 account/rateLimits/read）必须省略 params 键 */
export interface JsonRpcRequestFrame {
    id: number;
    method: string;
    params?: unknown;
}

/** 服务端通知帧（无 id） */
export interface JsonRpcNotificationFrame {
    method: string;
    params?: unknown;
}

/** 服务端反向请求帧（有 id 有 method，需要客户端响应） */
export interface JsonRpcServerRequestFrame {
    id: number | string;
    method: string;
    params?: unknown;
}

export interface JsonRpcResponseFrame {
    id: number | string;
    result?: unknown;
    error?: JsonRpcErrorObject;
}
