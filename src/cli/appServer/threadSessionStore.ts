/*---------------------------------------------------------------------------------------------
 *  Codex App Server 模式 B：sessionId → 持久 thread 会话映射（内存 LRU）
 *  与官方 Copilot conversationStore 同构：进程内维护，扩展重启后由 marker 恢复
 *--------------------------------------------------------------------------------------------*/

/** 持久 thread 会话条目 */
export interface CodexThreadSession {
    sessionId: string;
    threadId: string;
    /** 最近完成的 turn ID（增量定位/回滚锚点） */
    lastTurnId?: string;
    modelId: string;
    /** 新建 thread 时注册的 dynamicTools 名集合（排序）；跨轮漂移检测用，resume 不更新工具集 */
    toolNames?: string[];
    updatedAt: number;
}

/**
 * sessionId → thread 会话的内存映射（LRU，容量上限）
 * 淘汰条目需由调用方负责 thread/archive 清理远端资源
 */
export class CodexThreadSessionStore {
    private static readonly MAX_ENTRIES = 100;
    private readonly sessions = new Map<string, CodexThreadSession>();

    get(sessionId: string): CodexThreadSession | undefined {
        const entry = this.sessions.get(sessionId);
        if (entry) {
            // LRU：触碰后移到末尾
            this.sessions.delete(sessionId);
            this.sessions.set(sessionId, entry);
        }
        return entry;
    }

    /**
     * 写入/更新条目；返回因容量淘汰被逐出的条目（调用方负责 archive）
     */
    set(entry: CodexThreadSession): CodexThreadSession[] {
        this.sessions.delete(entry.sessionId);
        this.sessions.set(entry.sessionId, entry);
        const evicted: CodexThreadSession[] = [];
        while (this.sessions.size > CodexThreadSessionStore.MAX_ENTRIES) {
            const oldestKey = this.sessions.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            const oldest = this.sessions.get(oldestKey);
            this.sessions.delete(oldestKey);
            if (oldest) {
                evicted.push(oldest);
            }
        }
        return evicted;
    }

    delete(sessionId: string): CodexThreadSession | undefined {
        const entry = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        return entry;
    }
}

/** 进程级单例 */
export const codexThreadSessionStore = new CodexThreadSessionStore();
