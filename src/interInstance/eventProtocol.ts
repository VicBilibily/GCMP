/*---------------------------------------------------------------------------------------------
 *  跨实例事件协议
 *  定义 VS Code 多窗口之间通过 IPC 传输的事件类型与序列化格式
 *--------------------------------------------------------------------------------------------*/

/**
 * 跨实例事件基类
 */
export interface InterInstanceEventBase {
    /** 事件类型 */
    type: string;
    /** 事件负载 */
    payload: unknown;
    /** 事件发送时间戳（毫秒） */
    timestamp: number;
    /** 发送者实例 ID */
    senderInstanceId: string;
}

/**
 * 状态栏状态已更新
 */
export interface StatusUpdatedEvent extends InterInstanceEventBase {
    type: 'statusUpdated';
    payload: {
        /** 状态栏/提供商标识 */
        providerKey: string;
        /** 状态数据（由各状态栏子类定义具体结构） */
        data: unknown;
        /** 数据来源 */
        source: 'api' | 'cache';
    };
}

/**
 * API Key 已变更
 */
export interface ApiKeyChangedEvent extends InterInstanceEventBase {
    type: 'apiKeyChanged';
    payload: {
        /** 提供商标识 */
        provider: string;
        /** 变更动作 */
        action: 'set' | 'delete' | 'sync';
    };
}

/**
 * GCMP 配置已变更
 */
export interface ConfigChangedEvent extends InterInstanceEventBase {
    type: 'configChanged';
    payload: {
        /** 发生变化的配置键列表 */
        changedKeys: string[];
    };
}

/**
 * Token 用量已更新
 */
export interface TokenUsageUpdatedEvent extends InterInstanceEventBase {
    type: 'tokenUsageUpdated';
    payload: {
        /** 日期字符串，如 2026-07-01 */
        date: string;
        /** 今日总 Token 数 */
        totalTokens: number;
        /** 今日总请求数 */
        totalRequests: number;
        /** 完整统计数据（可选） */
        stats?: unknown;
    };
}

/**
 * Gist 同步已完成
 */
export interface SyncCompletedEvent extends InterInstanceEventBase {
    type: 'syncCompleted';
    payload: {
        /** 同步方向 */
        direction: 'upload' | 'download';
        /** 是否成功 */
        success: boolean;
        /** 涉及/应用的密钥数量 */
        keyCount?: number;
    };
}

/**
 * Leader 已变更
 */
export interface LeaderChangedEvent extends InterInstanceEventBase {
    type: 'leaderChanged';
    payload: {
        /** 新的 Leader 实例 ID */
        leaderId: string;
    };
}

/**
 * Leader 即将卸任
 * Leader 实例关闭前广播此事件，提示 Follower 立即开始新 Leader 竞选，
 * 避免等待心跳超时（15 秒）造成的任务空窗。
 * 可指定建议的下一任 Leader，非提名实例默认不参与本轮竞选，减少抢占。
 * 该事件属于停机优化信号而非可靠控制消息；IPC 不可用时允许自然退化为 session 级心跳选举。
 */
export interface LeaderResigningEvent extends InterInstanceEventBase {
    type: 'leaderResigning';
    payload: {
        /** 卸任 Leader 的实例 ID */
        leaderId: string;
        /** 建议的下一任 Leader 实例 ID（可选） */
        nextLeaderId?: string;
    };
}

/**
 * 实时流式指标已更新
 * 高频事件，仅通过 IPC 传输，不降级到文件系统。
 * payload.event 的字段语义与 LiveStreamMetricEvent 保持一致，修改时请同步更新。
 */
export interface LiveMetricsUpdatedEvent extends InterInstanceEventBase {
    type: 'liveMetricsUpdated';
    payload: {
        /** 实时流式指标事件 */
        event: {
            type: 'requestStarted' | 'firstChunk' | 'streamingUpdate' | 'streamEnd';
            requestId: string;
            requestStartTime: number;
            providerName: string;
            modelName: string;
            streamStartTime?: number;
            firstChunkLatencyMs?: number;
            estimatedOutputTokens?: number;
            lastOutputTokenDelta?: number;
            lastFlushSeq?: number;
            tokensPerSecond?: number;
        };
    };
}

/**
 * CLI 认证刷新请求
 * 由非主实例发出，请求主实例刷新指定 CLI provider 的 OAuth 凭证文件。
 * 仅传递 provider 标识与请求元数据，不在跨实例事件中携带 access_token / refresh_token。
 */
export interface CliAuthRefreshRequestedEvent extends InterInstanceEventBase {
    type: 'cliAuthRefreshRequested';
    payload: {
        /** 请求 ID，用于匹配完成回执 */
        requestId: string;
        /** CLI provider 标识（如 codex / grok） */
        providerKey: string;
        /** 是否强制刷新访问令牌（true 表示即使未过期也刷新） */
        forceRefresh: boolean;
        /** 请求来源实例 ID */
        requestedBy: string;
    };
}

/**
 * CLI 认证刷新完成回执
 * 主实例完成指定 provider 的刷新后广播结果；调用方随后自行从本地凭证文件重新加载。
 */
export interface CliAuthRefreshCompletedEvent extends InterInstanceEventBase {
    type: 'cliAuthRefreshCompleted';
    payload: {
        /** 对应的请求 ID */
        requestId: string;
        /** CLI provider 标识 */
        providerKey: string;
        /** 是否刷新成功 */
        success: boolean;
        /** 失败时的错误摘要 */
        error?: string;
    };
}

/**
 * 统计刷新请求
 * 由非主实例（Follower）发出，请求主实例（Leader）执行 stats.json 的重算与写盘。
 * 触发场景：
 * - 本实例有请求完成需要刷新今日 stats（doRefreshCurrentStats）
 * - 用户在本实例打开统计页面，需要全量重建过期 stats（regenerateOutdatedStats）
 *
 * 设计意图：stats.json 写入由 Leader 串行化，避免多实例并发写覆盖。
 * 直连 IPC 不可用时可退化到 fallback 通道；若 leader 尚未选出或请求丢失，Leader 的周期任务仍会兜底刷新今日 stats。
 */
export interface StatsRefreshRequestedEvent extends InterInstanceEventBase {
    type: 'statsRefreshRequested';
    payload: {
        /** 请求 ID，用于匹配 Leader 的完成回执（statsRefreshCompleted） */
        requestId: string;
        /** 要刷新的日期字符串 (YYYY-MM-DD)。regenerateAll=true 时忽略此字段 */
        date?: string;
        /** 是否触发全量过期检测并重建所有过期日期的 stats */
        regenerateAll: boolean;
        /** 请求来源实例 ID（用于日志追踪，与 senderInstanceId 相同但语义更明确） */
        requestedBy: string;
    };
}

/**
 * 统计刷新完成回执
 * 由主实例（Leader）在完成 statsRefreshRequested 对应的刷新后广播。
 * 非主实例（Follower）中等待同步结果的调用方（如 getMultiDayStats 前的 regenerateOutdatedStats）
 * 通过 requestId 匹配并解除阻塞，确保后续读取到的 stats.json/index.json 已是最新。
 */
export interface StatsRefreshCompletedEvent extends InterInstanceEventBase {
    type: 'statsRefreshCompleted';
    payload: {
        /** 对应的请求 ID（与 statsRefreshRequested.requestId 匹配） */
        requestId: string;
        /** 成功重建的日期列表 */
        regeneratedDates: string[];
    };
}

/**
 * 跨实例事件联合类型
 */
export type InterInstanceEvent =
    | StatusUpdatedEvent
    | ApiKeyChangedEvent
    | ConfigChangedEvent
    | TokenUsageUpdatedEvent
    | SyncCompletedEvent
    | LeaderChangedEvent
    | LeaderResigningEvent
    | LiveMetricsUpdatedEvent
    | CliAuthRefreshRequestedEvent
    | CliAuthRefreshCompletedEvent
    | StatsRefreshRequestedEvent
    | StatsRefreshCompletedEvent;

/**
 * 事件类型名称集合（用于运行时校验）
 */
export const INTER_INSTANCE_EVENT_TYPES = [
    'statusUpdated',
    'apiKeyChanged',
    'configChanged',
    'tokenUsageUpdated',
    'syncCompleted',
    'leaderChanged',
    'leaderResigning',
    'liveMetricsUpdated',
    'cliAuthRefreshRequested',
    'cliAuthRefreshCompleted',
    'statsRefreshRequested',
    'statsRefreshCompleted'
] as const;

/**
 * 将事件序列化为 NDJSON 行
 */
export function serializeEvent(event: InterInstanceEvent): string {
    return JSON.stringify(event) + '\n';
}

/**
 * 从 NDJSON 缓冲区中解析出完整的事件对象
 * @returns 解析出的事件列表，以及未处理完的残留缓冲区
 */
export function parseEventsFromBuffer(buffer: string): { events: InterInstanceEvent[]; remaining: string } {
    const lines = buffer.split('\n');
    const remaining = lines.pop() ?? '';
    const events: InterInstanceEvent[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const parsed = JSON.parse(trimmed) as InterInstanceEvent;
            if (INTER_INSTANCE_EVENT_TYPES.includes(parsed.type)) {
                events.push(parsed);
            }
        } catch {
            // 忽略无法解析的行
        }
    }

    return { events, remaining };
}

/**
 * 增量消费 NDJSON 事件块。
 * 将上一次未解析完的尾部文本与本次新增块拼接后统一解析，
 * 调用方必须保存返回的 remaining 用于下一次继续消费。
 */
export function parseIncrementalEvents(
    previousRemaining: string,
    chunk: string
): { events: InterInstanceEvent[]; remaining: string } {
    return parseEventsFromBuffer(previousRemaining + chunk);
}

/**
 * 事件订阅回调类型
 */
export type InterInstanceEventHandler<T extends InterInstanceEvent = InterInstanceEvent> = (event: T) => void;
