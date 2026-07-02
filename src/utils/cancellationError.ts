/*---------------------------------------------------------------------------------------------
 *  取消错误检测工具
 *  覆盖所有已知的取消错误类型，包括嵌套 error.cause / error.error 模式
 *--------------------------------------------------------------------------------------------*/

/**
 * 判断给定错误是否为取消/中止类错误。
 *
 * 覆盖类型：
 * - vscode.CancellationError
 * - DOM/Node.js AbortError（error.name === 'AbortError'）
 * - OpenAI SDK APIUserAbortError
 * - Anthropic SDK APIUserAbortError
 * - 嵌套模式：error.cause 或 error.error 为以上任一类型
 * - 深层嵌套 / 循环引用：通过迭代遍历 + WeakSet 去重避免死循环与递归爆栈
 */
export function isCancellationError(error: unknown): boolean {
    if (!isRecord(error)) {
        return false;
    }

    const stack: Record<string, unknown>[] = [error];
    const visited = new WeakSet<object>();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || visited.has(current)) {
            continue;
        }

        visited.add(current);

        // 直接匹配当前节点
        if (isCancellationLike(current)) {
            return true;
        }

        // 继续向下遍历支持的嵌套字段
        pushIfRecord(stack, current.cause);
        pushIfRecord(stack, current.error);
    }

    return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object';
}

function pushIfRecord(stack: Record<string, unknown>[], value: unknown): void {
    if (isRecord(value)) {
        stack.push(value);
    }
}

function isCancellationLike(obj: Record<string, unknown>): boolean {
    // vscode.CancellationError — 运行时 name 为 'Canceled'（不是 'CancellationError'），
    // constructor.name 在 esbuild 打包后可能被 mangle，因此 name 检测最可靠。
    // 同时保留 constructor.name 检测作为兜底。
    if (
        (typeof obj.name === 'string' && (obj.name === 'CancellationError' || obj.name === 'Canceled')) ||
        obj.constructor?.name === 'CancellationError'
    ) {
        return true;
    }

    // DOM/Node.js AbortError
    if (typeof obj.name === 'string' && obj.name === 'AbortError') {
        return true;
    }

    // Anthropic SDK APIUserAbortError
    // 注意：不区分 SDK 来源，仅按类名匹配。OpenAI SDK 和 Anthropic SDK 都有同名类，
    // JavaScript 运行时不区分包，constructor.name 检测对两者都有效。
    if (obj.constructor?.name === 'APIUserAbortError') {
        return true;
    }

    return false;
}
