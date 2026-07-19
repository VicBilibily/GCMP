/*---------------------------------------------------------------------------------------------
 *  格式化工具函数
 *--------------------------------------------------------------------------------------------*/

/**
 * 格式化 Opencode 专用标识符
 * 将原始 ID（如 requestId, sessionId）转换为 Opencode 约定的格式：
 * 清理非字母数字字符 → 取末尾 22 位 → 在倒数第 7 位前插入 #
 * 结果形如：xxxxxxxxxxxxx#xxxxxxx
 */
export function formatOpenCodeId(id: string): string {
    const cleaned = id.replace(/[^a-zA-Z0-9]/g, '');
    const tail = cleaned.slice(-22);
    return `${tail.slice(7)}#${cleaned.slice(0, 7)}`;
}

/**
 * 创建 OpenCode 请求级跟踪标识头
 * 包含 x-opencode-project、x-opencode-request、x-opencode-session
 */
export function createOpenCodeHeaders(requestId: string, sessionId: string): Record<string, string> {
    return {
        'x-opencode-project': 'global',
        'x-opencode-request': `msg_${formatOpenCodeId(requestId)}`,
        'x-opencode-session': `ses_${formatOpenCodeId(sessionId)}`
    };
}
