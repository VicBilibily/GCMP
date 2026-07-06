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
    | LiveMetricsUpdatedEvent;

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
    'liveMetricsUpdated'
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
 * 事件订阅回调类型
 */
export type InterInstanceEventHandler<T extends InterInstanceEvent = InterInstanceEvent> = (event: T) => void;
