/*---------------------------------------------------------------------------------------------
 *  Diff 片段服务
 *  从 unified diff（git diff 输出的补丁格式）中提取“按文件”的片段。
 *--------------------------------------------------------------------------------------------*/

/**
 * 单个文件的 diff 片段
 */
export interface FileDiffSnippet {
    filePath: string;
    /** 片段内容（保持类似 unified diff 的头部和 hunk（变更块）结构）。 */
    excerpt: string;
    /** 粗略大小（字符数），用于分片/拆分决策。 */
    charCount: number;
}

export class DiffSnippetService {
    /**
     * 构建按文件的 diff 片段。
     * 说明：按 `diff --git` 将 unified diff 切分为“每个文件一个片段”。
     * - 仅当单文件片段超过上限时才截断
     * - 片段数量最多为 maxFiles（超出部分丢弃）
     */
    static buildSnippets(
        unifiedDiff: string,
        options?: {
            maxExcerptCharsPerFile?: number;
            maxFiles?: number;
        }
    ): FileDiffSnippet[] {
        const maxExcerptCharsPerFile = options?.maxExcerptCharsPerFile ?? 12000;
        const maxFiles = options?.maxFiles ?? 50;

        const lines = unifiedDiff.split(/\r?\n/);
        const snippets: FileDiffSnippet[] = [];

        let currentLines: string[] | null = null;
        let currentFilePath = '';

        const flush = () => {
            if (!currentLines || currentLines.length === 0) {
                currentLines = null;
                currentFilePath = '';
                return;
            }
            let excerpt = currentLines.join('\n').trim();
            if (excerpt && excerpt.length > maxExcerptCharsPerFile) {
                excerpt = excerpt.slice(0, maxExcerptCharsPerFile) + '\n... [file excerpt truncated]';
            }
            if (excerpt) {
                snippets.push({
                    filePath: currentFilePath || '(unknown-file)',
                    excerpt,
                    charCount: excerpt.length
                });
            }
            currentLines = null;
            currentFilePath = '';
        };

        for (const line of lines) {
            if (line.startsWith('diff --git ')) {
                flush();
                if (snippets.length >= maxFiles) {
                    break;
                }
                currentLines = [line];
                const paths = this.parseDiffGitHeaderPaths(line);
                currentFilePath = paths[1] || paths[0] || '';
                continue;
            }

            if (!currentLines) {
                continue;
            }
            currentLines.push(line);
        }

        flush();
        return snippets.slice(0, maxFiles);
    }

    /**
     * 将 `diff --git` 头部中剩余的路径部分做 token 化。
     *
     * 目标：在不依赖 shell 分词的情况下，尽量还原 git 输出的两个路径 token（aPath/bPath）。
     * - 兼容带双引号的路径 token（git 可能输出 C 风格引号字符串）
     * - 兼容反斜杠转义（保留 `\` 以便后续解码）
     *
     * 注意：这里只负责切 token，不负责去除 a/、b/ 前缀或解码引号/转义。
     */
    private static tokenizeDiffGitPaths(rest: string): string[] {
        // 分词时要兼容带引号的路径（git 会用 C 风格引号字符串表示含特殊字符的路径）。
        const out: string[] = [];
        let cur = '';
        let inQuotes = false;
        let escape = false;
        for (const ch of rest) {
            if (escape) {
                cur += ch;
                escape = false;
                continue;
            }
            if (ch === '\\') {
                // 保留反斜杠，让 JSON.parse（处理带引号的标记）能够正确解码转义。
                cur += ch;
                escape = true;
                continue;
            }
            if (ch === '"') {
                cur += ch;
                inQuotes = !inQuotes;
                continue;
            }
            if (!inQuotes && ch === ' ') {
                if (cur) {
                    out.push(cur);
                    cur = '';
                }
                continue;
            }
            cur += ch;
        }
        if (cur) {
            out.push(cur);
        }
        return out;
    }

    /**
     * 解码单个路径 token。
     *
     * - 若 token 是双引号包裹：尝试用 JSON.parse 解码转义（例如 `\n`、`\t`、`\"` 等）
     * - 否则：做一个轻量回退，仅将 `\ ` 还原为空格（git 在非引号场景可能这样转义空格）
     */
    private static decodeGitPathToken(token: string): string {
        const t = token.trim();
        if (t.startsWith('"') && t.endsWith('"')) {
            try {
                return JSON.parse(t);
            } catch {
                return t.slice(1, -1);
            }
        }
        // 非引号场景：git 可能用反斜杠转义空格等字符。
        return t.replace(/\\ /g, ' ');
    }

    /**
     * 解析单行 `diff --git ...` header，返回 [aPath, bPath]。
     *
     * 行格式示例：
     * - `diff --git a/src/a.ts b/src/a.ts`
     * - `diff --git "a/space file.txt" "b/space file.txt"`
     *
     * 行为：
     * - 使用 tokenizeDiffGitPaths 将 header 后半段切成两个路径 token
     * - 使用 decodeGitPathToken 解码引号/转义
     * - 返回值会去除开头的 `a/` 与 `b/` 前缀（如果存在）
     *
     * 解析失败（无法得到两个 token）时返回 ['', '']。
     */
    private static parseDiffGitHeaderPaths(line: string): [string, string] {
        const rest = line.slice('diff --git '.length);
        const tokens = this.tokenizeDiffGitPaths(rest);
        if (tokens.length < 2) {
            return ['', ''];
        }

        const aRaw = this.decodeGitPathToken(tokens[0]);
        const bRaw = this.decodeGitPathToken(tokens[1]);
        const aPath = aRaw.startsWith('a/') ? aRaw.slice(2) : aRaw;
        const bPath = bRaw.startsWith('b/') ? bRaw.slice(2) : bRaw;
        return [aPath || '', bPath || ''];
    }
}
