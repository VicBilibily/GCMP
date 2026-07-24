/*---------------------------------------------------------------------------------------------
 *  Anthropic 缓存断点注入（纯逻辑模块，不依赖 vscode，可被 node:test 覆盖）
 *
 *  背景：VS Code 1.130 起上游对第三方 vendor 模型不再下发 cache_control DataPart，
 *  导致 Anthropic 模型（尤其 Opus 4.x）缓存命中率骤降（GCMP #314）。
 *
 *  策略与 VS Code Copilot 官方 addToolsAndSystemCacheControl（#4410 结论）一致：
 *  - 缓存层级为 tools → system → messages，前缀越稳定越值得缓存；
 *  - 给最后一个非 defer_loading 工具打断点（缓存整段工具前缀），再给 system 块打；
 *  - 消息级断点不驱逐——它们隐式缓存了 tools+system 前缀且覆盖更多内容；
 *  - 已有断点总数达上限时不再添加。
 *--------------------------------------------------------------------------------------------*/

/** Anthropic 单请求最多允许 4 个 cache_control 断点 */
const maxCacheBreakpoints = 4;

/** 缓存控制类型（Anthropic 目前仅支持 ephemeral） */
export const AnthropicCacheType = 'ephemeral';

interface CacheableBlock {
    cache_control?: { type: string } | null;
}

/** 判断内容块是否支持缓存控制（thinking / redacted_thinking 不支持） */
function blockSupportsCacheControl(block: { type: string }): boolean {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

export interface AnthropicCacheableTool {
    name: string;
    cache_control?: { type: string } | null;
    /** 延迟加载工具（defer_loading）不进系统前缀，不可作为缓存断点（对齐官方策略） */
    defer_loading?: boolean;
}

export interface AnthropicCacheableMessage {
    role?: string;
    content: unknown;
}

interface AnthropicContentBlock {
    type: string;
    cache_control?: { type: string } | null;
}

function getBlocks(msg: AnthropicCacheableMessage): AnthropicContentBlock[] {
    return Array.isArray(msg.content) ? (msg.content as AnthropicContentBlock[]) : [];
}

/** 是否含 tool_result 块（一轮工具调用的结果） */
function hasToolResult(msg: AnthropicCacheableMessage): boolean {
    return getBlocks(msg).some(b => b.type === 'tool_result');
}

/** 是否含 tool_use 块（assistant 发起了工具调用） */
function hasToolUse(msg: AnthropicCacheableMessage): boolean {
    return getBlocks(msg).some(b => b.type === 'tool_use');
}

/** 给消息最后一个可缓存块打断点（消息级断点附着在最后内容块上） */
function markLastBlock(msg: AnthropicCacheableMessage): boolean {
    const blocks = getBlocks(msg);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (blockSupportsCacheControl(b) && !b.cache_control) {
            b.cache_control = { type: AnthropicCacheType };
            return true;
        }
    }
    return false;
}

/**
 * 为 Anthropic 请求注入缓存断点。
 * @param tools 工具数组（服务端工具类型无 input_schema，不可缓存）
 * @param messagesResult 转换后的消息与 system 块
 */
export function addCacheControlBreakpoints(
    tools: AnthropicCacheableTool[],
    messagesResult: { messages: AnthropicCacheableMessage[]; system?: CacheableBlock & { text?: string } }
): void {
    // 统计已有断点（tools + system + messages）
    let existingCount = 0;
    for (const tool of tools) {
        if (tool.cache_control) {
            existingCount++;
        }
    }
    if (messagesResult.system?.cache_control) {
        existingCount++;
    }
    for (const msg of messagesResult.messages) {
        if (!Array.isArray(msg.content)) {
            continue;
        }
        for (const block of msg.content as ({ type: string } & CacheableBlock)[]) {
            if (blockSupportsCacheControl(block) && block.cache_control) {
                existingCount++;
            }
        }
    }

    let slotsAvailable = maxCacheBreakpoints - existingCount;
    if (slotsAvailable <= 0) {
        return;
    }

    // 最后一个可缓存工具：cache_control 打在 tools 数组最后一个非 defer_loading
    // 工具上，缓存整段工具前缀（对齐官方 addToolsAndSystemCacheControl 策略）。
    // defer_loading 的工具不进系统前缀，不能作为断点。
    for (let i = tools.length - 1; i >= 0; i--) {
        const tool = tools[i];
        if (tool.defer_loading || tool.cache_control) {
            continue;
        }
        tool.cache_control = { type: AnthropicCacheType };
        slotsAvailable--;
        break;
    }

    // system 块（缓存稳定系统前缀）
    const systemBlock = messagesResult.system;
    if (systemBlock && !systemBlock.cache_control && slotsAvailable > 0 && systemBlock.text?.trim()) {
        systemBlock.cache_control = { type: AnthropicCacheType };
        slotsAvailable--;
    }

    // 消息级断点：对齐 VS Code 1.129 addCacheBreakpoints 规则，在转换后的
    // Anthropic MessageParam 层补充（上游不再对第三方 vendor 下发 cache_control）。
    // 倒序遍历：当前 user 消息之下 → 每轮最后一个 tool_result 与当前 user；
    // 之上 → 无工具调用的 assistant（一轮的终止回复）。
    addMessageLevelBreakpoints(messagesResult.messages, slotsAvailable);
}

/**
 * 在转换后的 Anthropic 消息层补充消息级缓存断点（对齐 VS Code 1.129 规则）。
 *
 * 角色映射（Raw → Anthropic）：
 * - Raw.Tool（tool result）→ user 消息内的 tool_result 块；
 * - Raw.Assistant 的 toolCalls → assistant 消息内的 tool_use 块；
 * - 连续同角色消息已合并，故一轮工具调用 = [assistant(含 tool_use)] + [user(含 tool_result)]。
 *
 * @returns 实际添加的断点数
 */
function addMessageLevelBreakpoints(messages: AnthropicCacheableMessage[], slotsAvailable: number): number {
    let added = 0;
    let hasPassedCurrentUserMessage = false;

    for (let i = messages.length - 1; i >= 0 && slotsAvailable > 0; i--) {
        const msg = messages[i];
        const nextMsg = messages[i + 1]; // 数组里更靠后的消息（倒序扫描时的"后一条"）

        // 一轮最后一个 tool_result：当前是含 tool_result 的 user，且其后不再是 tool_result user
        const isLastToolResultInRound =
            msg.role === 'user' && hasToolResult(msg) && !(nextMsg?.role === 'user' && hasToolResult(nextMsg));
        // 无工具调用的 assistant（一轮的终止回复）
        const isAsstMsgWithNoTools = msg.role === 'assistant' && !hasToolUse(msg);
        // 当前 user 消息：倒序扫描中尚未越过“当前 user”边界的第一个 user；
        // 混合 tool_result + text 的 user 也会命中该边界。
        const isCurrentUserMessage = msg.role === 'user' && !hasPassedCurrentUserMessage;

        const shouldMark =
            (!hasPassedCurrentUserMessage && (isLastToolResultInRound || isCurrentUserMessage)) || isAsstMsgWithNoTools;

        if (shouldMark && !getBlocks(msg).some(b => b.cache_control)) {
            if (markLastBlock(msg)) {
                slotsAvailable--;
                added++;
            }
        }

        // 仅当 user 包含非 tool_result 块时才视为已越过“当前 user”边界
        if (msg.role === 'user' && getBlocks(msg).some(b => b.type !== 'tool_result')) {
            hasPassedCurrentUserMessage = true;
        }
    }

    // 前缀回填：若仍有空位，则按 1.129 规则给最早的用户前缀补齐断点
    for (let i = 0; i < messages.length && slotsAvailable > 0; i++) {
        const msg = messages[i];
        if (msg.role !== 'user') {
            break;
        }
        if (!getBlocks(msg).some(b => b.cache_control) && markLastBlock(msg)) {
            slotsAvailable--;
            added++;
        }
    }

    return added;
}
