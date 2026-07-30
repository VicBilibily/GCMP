/*---------------------------------------------------------------------------------------------
 *  会话标题服务
 *  新会话时从 Copilot 封装的消息中提取 <userRequest> 原始输入，仅作 matchKey 记录；
 *  并接收 chat-title 生成请求的响应，将其升级为 VS Code 面板显示标题（唯一展示来源）。
 *
 *  当前实现仅维护进程内运行时映射；旧的 sessions.json 共享持久化链路已移除，
 *  跨天/重启后的标题恢复改由 usage log 中已落盘的 sessionTitle 快照懒恢复完成。
 *--------------------------------------------------------------------------------------------*/

/** 聊天消息结构（鸭子类型，避免依赖 vscode 以便 node:test 运行） */
export interface ChatMessageLike {
    role: number;
    content: ReadonlyArray<unknown>;
}

/** 会话标题来源：raw=仅匹配键（无展示标题）；generated=VS Code 标题生成请求的响应（唯一展示来源） */
export type SessionTitleSource = 'raw' | 'generated';

export interface SessionTitleEntry {
    /** 展示标题（raw 条目为空字符串，不对外展示） */
    title: string;
    /** 匹配键（归一化后的首条用户输入，用于与标题生成请求匹配；仅内存 raw 条目需要） */
    matchKey?: string;
    source: SessionTitleSource;
    updatedAt: number;
    /** 会话在当前进程中首次登记时间，用于同 key 冲突时的归属判断 */
    startedAt?: number;
    /** 最近一次请求完成时间；缺省表示当前仍有进行中的正式请求 */
    completedAt?: number;
    /** 最近一次正式请求 ID，用于标题晚到时回写 usage log */
    requestId?: string;
}

export interface ResolvedSessionTitle {
    sessionId: string;
    requestId?: string;
    title: string;
}

interface PendingGeneratedTitle {
    title: string;
    updatedAt: number;
}

/** vscode.LanguageModelChatMessageRole.User 的枚举值（本地常量避免依赖 vscode） */
const ROLE_USER = 1;

/** Copilot 封装用户输入的标签 */
const USER_REQUEST_PATTERN = /<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/;

/** Copilot 标题生成请求的用户提示前缀（见 microsoft/vscode extensions/copilot title.tsx） */
const TITLE_REQUEST_PREFIX = 'Please write a brief title for the following request:';

const MAX_TITLE_LENGTH = 60;
/** matchKey 防呆上限：正常输入远不及此长度，仅防极端超长输入撑爆内存/持久化 */
const MAX_MATCH_KEY_LENGTH = 4000;
/** 前缀兜底匹配的最小长度：低于此长度的匹配键太短，前缀匹配不可靠，只允许精确匹配 */
const MIN_PREFIX_MATCH_LENGTH = 20;
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 2000;

function extractTextFromContent(content: ReadonlyArray<unknown>): string {
    let text = '';
    for (const part of content) {
        const value = (part as { value?: unknown } | null)?.value;
        if (typeof value === 'string') {
            text += value;
        }
    }
    return text;
}

/** 压缩连续空白为单个空格并 trim */
function normalizeWhitespace(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/** 生成展示用标题：清洗空白、去除模型可能带回的首尾引号/尾部句号、截断 */
export function toDisplayTitle(rawText: string, maxLength = MAX_TITLE_LENGTH): string {
    let cleaned = normalizeWhitespace(rawText);
    // 标题生成提示词要求不带引号/尾标点，但模型未必遵守，这里兜底清理；
    // 循环执行：尾部标点可能包裹在引号外（如 `"标题"。`），需交替剥离直到稳定
    let previous: string;
    do {
        previous = cleaned;
        cleaned = cleaned.replace(/^["'「『“”‘’]+|["'」』“”‘’]+$/g, '').replace(/[。.…]+$/g, '');
    } while (cleaned !== previous);
    if (cleaned.length <= maxLength) {
        return cleaned;
    }
    return cleaned.slice(0, maxLength - 1) + '…';
}

/** 生成匹配键：清洗空白（不主动截断——Copilot 侧文本可能被裁剪，截断会破坏等值与前缀匹配） */
function toMatchKey(rawText: string): string {
    return normalizeWhitespace(rawText).slice(0, MAX_MATCH_KEY_LENGTH);
}

/**
 * 在候选 matchKey 集合中查找与 key 匹配的键：
 * 1. 精确匹配优先；
 * 2. 前缀兜底：互为前缀且较短者长度 ≥ MIN_PREFIX_MATCH_LENGTH 时视为同一会话
 *    （容忍 Copilot 侧标题请求文本被 prompt-tsx 预算裁剪变短的场景）；
 *    多条命中时取最长者（区分度最高）。
 */
function findMatchingKey(key: string, candidates: Iterable<string>): string | undefined {
    let prefixMatch: string | undefined;
    for (const candidate of candidates) {
        if (candidate === key) {
            return candidate;
        }
        if (candidate.startsWith(key) || key.startsWith(candidate)) {
            const shorter = Math.min(candidate.length, key.length);
            if (
                shorter >= MIN_PREFIX_MATCH_LENGTH &&
                (prefixMatch === undefined || candidate.length > prefixMatch.length)
            ) {
                prefixMatch = candidate;
            }
        }
    }
    return prefixMatch;
}

/** 合并两条同 sessionId 的条目：generated 优先，其次取 updatedAt 较新者 */
export function mergeTitleEntry(base: SessionTitleEntry, overlay: SessionTitleEntry): SessionTitleEntry {
    const preferred =
        base.source !== overlay.source ?
            base.source === 'generated' ?
                base
            :   overlay
        : overlay.updatedAt > base.updatedAt ? overlay
        : base;
    const fallback = preferred === base ? overlay : base;
    const merged =
        !preferred.matchKey && fallback.matchKey ? { ...preferred, matchKey: fallback.matchKey } : { ...preferred };
    if (merged.startedAt === undefined && fallback.startedAt !== undefined) {
        merged.startedAt = fallback.startedAt;
    }
    if (merged.completedAt === undefined && fallback.completedAt !== undefined) {
        merged.completedAt = fallback.completedAt;
    }
    if (merged.requestId === undefined && fallback.requestId !== undefined) {
        merged.requestId = fallback.requestId;
    }
    return merged;
}

/**
 * 同 matchKey 候选中挑选唯一升级目标：
 * 仅考虑尚无标题的 raw 会话（已有 generated 标题的视为已完成关联，不重复覆盖）；
 * 优先仍在进行中的正式请求；若主请求已结束但标题晚到，则回退到最近完成的未命名会话。
 */
function pickUpgradeTarget(
    candidates: ReadonlyArray<readonly [string, SessionTitleEntry]>
): readonly [string, SessionTitleEntry] | undefined {
    let activeTarget: readonly [string, SessionTitleEntry] | undefined;
    let completedTarget: readonly [string, SessionTitleEntry] | undefined;
    for (const candidate of candidates) {
        const entry = candidate[1];
        if (entry.source !== 'raw') {
            continue;
        }
        if (entry.completedAt === undefined) {
            const entryStartedAt = entry.startedAt ?? entry.updatedAt;
            const targetStartedAt = activeTarget?.[1].startedAt ?? activeTarget?.[1].updatedAt ?? -1;
            if (!activeTarget || entryStartedAt > targetStartedAt) {
                activeTarget = candidate;
            }
            continue;
        }
        const entryCompletedAt = entry.completedAt ?? entry.updatedAt;
        const targetCompletedAt = completedTarget?.[1].completedAt ?? completedTarget?.[1].updatedAt ?? -1;
        if (!completedTarget || entryCompletedAt > targetCompletedAt) {
            completedTarget = candidate;
        }
    }
    return activeTarget ?? completedTarget;
}

export class SessionTitleService {
    static readonly instance = new SessionTitleService();

    private readonly entries = new Map<string, SessionTitleEntry>();
    /** 标题生成请求先到、会话尚未注册时的暂存（按 matchKey） */
    private readonly pendingGenerated = new Map<string, PendingGeneratedTitle[]>();

    /**
     * 从 Copilot 封装的消息中提取首个 <userRequest> 标签内的原始用户输入。
     * 从最早一条 user 消息开始匹配：会话话题由首条真实输入决定；
     * agent 循环的 tool_result 续轮与 Copilot 内部子请求均不含该标签，天然免疫。
     */
    static extractUserRequestText(messages: readonly ChatMessageLike[]): string | undefined {
        for (const message of messages) {
            if (message.role !== ROLE_USER) {
                continue;
            }
            const match = USER_REQUEST_PATTERN.exec(extractTextFromContent(message.content));
            if (match?.[1]) {
                return match[1];
            }
        }
        return undefined;
    }

    /** 从 chat-title 生成请求中提取待命名的原始请求文本 */
    static extractTitleGenerationRequestText(messages: readonly ChatMessageLike[]): string | undefined {
        for (const message of messages) {
            if (message.role !== ROLE_USER) {
                continue;
            }
            const text = extractTextFromContent(message.content);
            const idx = text.indexOf(TITLE_REQUEST_PREFIX);
            if (idx !== -1) {
                const raw = text.slice(idx + TITLE_REQUEST_PREFIX.length).trim();
                return raw || undefined;
            }
        }
        return undefined;
    }

    /**
     * 新会话注册：仅记录 matchKey（供 chat-title 请求回填匹配），
     * 不以首条输入截断作为展示标题（原文截断语义不可靠，且不写入日志更保护隐私）。
     * 若已有暂存的生成标题（标题请求先到达），直接采用。
     */
    registerSession(sessionId: string, rawUserText: string): void {
        if (!sessionId) {
            return;
        }
        const matchKey = toMatchKey(rawUserText);
        if (!matchKey) {
            return;
        }
        const now = Date.now();
        // 已有 generated 标题的会话不回退
        const existing = this.entries.get(sessionId);
        if (existing?.source === 'generated') {
            if (!existing.matchKey || existing.completedAt !== undefined) {
                this.entries.set(sessionId, {
                    ...existing,
                    matchKey: existing.matchKey ?? matchKey,
                    startedAt: now,
                    completedAt: undefined
                });
            }
            return;
        }

        this.prunePendingGenerated();
        const pending = this.consumePendingGenerated(matchKey);
        if (pending) {
            this.entries.set(sessionId, {
                title: pending.title,
                matchKey,
                source: 'generated',
                updatedAt: pending.updatedAt,
                startedAt: now,
                completedAt: undefined,
                requestId: undefined
            });
            this.pruneEntriesIfNeeded();
            return;
        }

        if (!existing) {
            this.entries.set(sessionId, {
                title: '',
                matchKey,
                source: 'raw',
                updatedAt: now,
                startedAt: now,
                completedAt: undefined,
                requestId: undefined
            });
        } else {
            // 已有 raw 条目且再次注册（同 sessionId 重复触发）：仅当 matchKey 变化时更新
            if (existing.matchKey === matchKey && existing.completedAt === undefined) {
                return;
            }
            this.entries.set(sessionId, {
                title: '',
                matchKey,
                source: 'raw',
                updatedAt: now,
                startedAt: now,
                completedAt: undefined,
                requestId: undefined
            });
        }
        this.pruneEntriesIfNeeded();
    }

    rememberRequest(sessionId: string, requestId: string): void {
        if (!sessionId || !requestId) {
            return;
        }
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return;
        }
        if (entry.requestId === requestId) {
            return;
        }
        entry.requestId = requestId;
        entry.updatedAt = Math.max(entry.updatedAt, Date.now());
    }

    /** 正式请求结束：会话保留在内存中，允许异常晚到的 chat-title 继续回填当前进程 UI。 */
    markSessionCompleted(sessionId: string): void {
        if (!sessionId) {
            return;
        }
        const entry = this.entries.get(sessionId);
        if (!entry) {
            return;
        }
        const completedAt = Date.now();
        if (entry.completedAt === completedAt && entry.updatedAt === completedAt) {
            return;
        }
        entry.completedAt = completedAt;
        entry.updatedAt = Math.max(entry.updatedAt, completedAt);
        this.pruneEntriesIfNeeded();
    }

    /**
     * chat-title 请求完成后的回填：按原始请求文本匹配会话，升级为 VS Code 正式标题。
     * 标题请求不携带 sessionId，同文会话仅靠文本无法完美区分，采用最可能归属策略：
     * 候选（精确匹配优先、前缀兜底）中优先升级一个"仍在进行且尚无标题"的会话；
     * 若正式请求已结束但标题晚到，则回退到最近完成的未命名会话。
     * 已有 generated 标题的会话不被后续同文会话的标题覆盖。
     * 无合适候选（无匹配，或同键会话均已有标题）时暂存，待同文新会话注册时采用。
     * @returns 是否立即匹配到会话
     */
    resolveGeneratedTitle(rawRequestText: string, generatedTitle: string): boolean {
        return !!this.resolveGeneratedTitleDetails(rawRequestText, generatedTitle);
    }

    resolveGeneratedTitleDetails(rawRequestText: string, generatedTitle: string): ResolvedSessionTitle | undefined {
        const matchKey = toMatchKey(rawRequestText);
        const title = toDisplayTitle(generatedTitle);
        if (!matchKey || !title) {
            return undefined;
        }
        this.prunePendingGenerated();
        let candidates = [...this.entries.entries()].filter(([, entry]) => entry.matchKey === matchKey);
        if (candidates.length === 0) {
            // 前缀兜底（Copilot 侧文本被裁剪变短）：取区分度最高（matchKey 最长）的候选键
            const matchKeys = [...this.entries.values()]
                .map(entry => entry.matchKey)
                .filter((key): key is string => typeof key === 'string');
            const candidateKey = findMatchingKey(matchKey, matchKeys);
            if (candidateKey) {
                candidates = [...this.entries.entries()].filter(([, entry]) => entry.matchKey === candidateKey);
            }
        }
        const target = pickUpgradeTarget(candidates);
        if (target) {
            const [sessionId, entry] = target;
            entry.title = title;
            entry.source = 'generated';
            entry.updatedAt = Date.now();
            return {
                sessionId,
                requestId: entry.requestId,
                title
            };
        }
        this.pushPendingGenerated(matchKey, { title, updatedAt: Date.now() });
        return undefined;
    }

    /**
     * 查询会话当前展示标题（映射表为权威来源，回填后立即反映）。
     * 仅 generated（VS Code 正式标题）对外展示；raw 条目无标题，调用方回退短 ID 显示。
     */
    getTitle(sessionId: string): string | undefined {
        const entry = this.entries.get(sessionId);
        return entry?.source === 'generated' && entry.title ? entry.title : undefined;
    }

    /**
     * 按 sessionId 注入已知正式标题（如从历史 usage log 懒恢复得到）。
     * generated 标题优先级高于 raw，会保留现有 matchKey 以便后续同会话继续参与匹配。
     */
    rememberResolvedTitle(sessionId: string, titleText: string, updatedAt = Date.now()): void {
        if (!sessionId) {
            return;
        }
        const title = toDisplayTitle(titleText);
        if (!title) {
            return;
        }
        const next: SessionTitleEntry = {
            title,
            source: 'generated',
            updatedAt
        };
        const existing = this.entries.get(sessionId);
        this.entries.set(sessionId, existing ? mergeTitleEntry(existing, next) : next);
        this.pruneEntriesIfNeeded();
    }

    private prunePendingGenerated(): void {
        const cutoff = Date.now() - PENDING_TTL_MS;
        for (const [key, queue] of this.pendingGenerated) {
            const alive = queue.filter(pending => pending.updatedAt >= cutoff);
            if (alive.length === 0) {
                this.pendingGenerated.delete(key);
                continue;
            }
            this.pendingGenerated.set(key, alive);
        }
    }

    private consumePendingGenerated(matchKey: string): PendingGeneratedTitle | undefined {
        const pendingKey = findMatchingKey(matchKey, this.pendingGenerated.keys());
        if (!pendingKey) {
            return undefined;
        }
        const queue = this.pendingGenerated.get(pendingKey);
        const pending = queue?.shift();
        if (!queue || queue.length === 0) {
            this.pendingGenerated.delete(pendingKey);
        }
        return pending;
    }

    private pushPendingGenerated(matchKey: string, pending: PendingGeneratedTitle): void {
        const pendingKey = findMatchingKey(matchKey, this.pendingGenerated.keys()) ?? matchKey;
        const queue = this.pendingGenerated.get(pendingKey) ?? [];
        queue.push(pending);
        this.pendingGenerated.set(pendingKey, queue);
    }

    private pruneEntriesIfNeeded(): void {
        if (this.entries.size <= MAX_ENTRIES) {
            return;
        }
        const sorted = [...this.entries.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
        const removeCount = this.entries.size - MAX_ENTRIES;
        for (let i = 0; i < removeCount; i++) {
            this.entries.delete(sorted[i][0]);
        }
    }
}
