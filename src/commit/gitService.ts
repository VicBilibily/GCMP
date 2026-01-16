/*---------------------------------------------------------------------------------------------
 *  Git 服务
 *  处理所有与 Git 相关的操作
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import type { API, GitExtension, Repository } from '../types/git';
import {
    NoChangesDetectedError,
    NoRepositoriesFoundError,
    NoRepositorySelectedError,
    GitExtensionNotFoundError
} from './types';
import { DiffSnippetService } from './diffSnippetService';
import { Logger } from '../utils';

function throwIfCancelled(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}

export interface GitDiffSection {
    /** 每个 diff 项对应的文件（索引相同）。 */
    uri: vscode.Uri[];
    /** 每个文件的统一 diff（与 uri 索引相同）。 */
    diff: string[];
}

export interface GitDiffParts {
    staged: GitDiffSection;
    /** working tree tracked 文件的变更（unstaged）。 */
    tracked: GitDiffSection;
    untracked: GitDiffSection;
}

/**
 * Git 服务类
 * 负责执行 Git 命令和管理 repository
 */
export class GitService {
    private static gitApi: API | null = null;
    private static execFileAsync = promisify(execFile);

    /**
     * 验证 Git 扩展是否可用
     */
    static async validateGitExtension(): Promise<void> {
        const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!gitExtension) {
            throw new GitExtensionNotFoundError();
        }

        if (!gitExtension.isActive) {
            await gitExtension.activate();
        }

        const gitApi = gitExtension.exports.getAPI(1);
        if (!gitApi) {
            throw new GitExtensionNotFoundError();
        }

        this.gitApi = gitApi;
    }

    private static async getRepositoryByPath(repoPath: string): Promise<Repository> {
        const repos = await this.getRepositories();
        const normalized = vscode.Uri.file(repoPath).fsPath;
        const found = repos.find(r => r.rootUri.fsPath === normalized);
        return found ?? repos[0];
    }

    /**
     * 获取所有 repository
     */
    static async getRepositories(): Promise<Repository[]> {
        if (!this.gitApi) {
            await this.validateGitExtension();
        }

        const repositories = this.gitApi?.repositories;
        if (!repositories || repositories.length === 0) {
            throw new NoRepositoriesFoundError();
        }

        return repositories;
    }

    /**
     * 让用户选择 repository
     */
    static async selectRepository(repos: Repository[]): Promise<Repository> {
        const items = repos.map(repo => ({
            label: repo.rootUri.fsPath,
            description: repo.rootUri.fsPath,
            repository: repo
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择一个 Git repository'
        });

        if (!selected) {
            throw new NoRepositorySelectedError();
        }

        return selected.repository;
    }

    /**
     * 获取代码 diff（分部分返回）
     * - staged: staged 变更
     * - tracked: working tree tracked 文件的 unstaged 变更
     * - untracked: untracked 新文件（以"新增文件"unified diff 形式拼出）
     *
     * 每个部分都返回 { uri: [], diff: [] }，两数组按 index 对齐。
     */
    static async getDiff(
        repoPath: string,
        onlyStagedChanges: boolean,
        token?: vscode.CancellationToken
    ): Promise<GitDiffParts> {
        try {
            throwIfCancelled(token);

            const repo = await this.getRepositoryByPath(repoPath);
            await repo.status();
            throwIfCancelled(token);

            const maxDiffCharsPerFile = 12000;

            const stagedUnified = await repo.diff(true);
            throwIfCancelled(token);
            const staged = this.unifiedDiffToSection(repoPath, stagedUnified, maxDiffCharsPerFile);

            if (onlyStagedChanges) {
                if (staged.diff.length === 0 || staged.diff.join('\n').trim() === '') {
                    throw new NoChangesDetectedError();
                }
                return { staged, tracked: { uri: [], diff: [] }, untracked: { uri: [], diff: [] } };
            }

            const trackedUnified = await repo.diff(false);
            throwIfCancelled(token);
            const tracked = this.unifiedDiffToSection(repoPath, trackedUnified, maxDiffCharsPerFile);

            const untracked = await this.getUntrackedSection(repoPath, repo, maxDiffCharsPerFile, token);

            if (staged.diff.length === 0 && tracked.diff.length === 0 && untracked.diff.length === 0) {
                throw new NoChangesDetectedError();
            }

            return { staged, tracked, untracked };
        } catch (error) {
            Logger.error('[GitService] 获取 diff 失败:', error);
            throw error;
        }
    }

    private static unifiedDiffToSection(
        repoPath: string,
        unifiedDiff: string,
        maxCharsPerFile: number
    ): GitDiffSection {
        const snippets = DiffSnippetService.buildSnippets(unifiedDiff ?? '', {
            maxExcerptCharsPerFile: maxCharsPerFile,
            maxFiles: Number.MAX_SAFE_INTEGER
        });

        const uri: vscode.Uri[] = [];
        const diff: string[] = [];

        for (const snip of snippets) {
            const filePath = (snip.filePath ?? '').trim();
            if (!filePath || filePath === '(unknown-file)') {
                continue;
            }
            // filePath 是相对于 repository 的路径，使用正斜杠。
            const fsPath = path.join(repoPath, filePath);
            uri.push(vscode.Uri.file(fsPath));
            diff.push(snip.excerpt);
        }

        return { uri, diff };
    }

    private static toGitPath(repoPath: string, fileFsPath: string): string {
        // git diff headers 使用正斜杠和相对于 repository 的路径。
        const rel = path.relative(repoPath, fileFsPath);
        return rel.split(path.sep).join('/');
    }

    private static looksBinary(buf: Uint8Array): boolean {
        // 启发式判断：NUL 字节几乎总是表示二进制文件。
        return buf.includes(0);
    }

    private static buildNewFileUnifiedDiff(repoRelativePath: string, content: string): string {
        const normalized = content.replace(/\r\n/g, '\n');
        const lines = normalized.length === 0 ? [] : normalized.split('\n');
        const plusLines = lines.map(l => `+${l}`);

        const header: string[] = [];
        header.push(`diff --git a/${repoRelativePath} b/${repoRelativePath}`);
        header.push('new file mode 100644');
        header.push('--- /dev/null');
        header.push(`+++ b/${repoRelativePath}`);

        if (plusLines.length === 0) {
            return header.join('\n');
        }

        header.push(`@@ -0,0 +1,${plusLines.length} @@`);
        header.push(...plusLines);
        return header.join('\n');
    }

    private static async getUntrackedSection(
        repoPath: string,
        repo: Repository,
        maxCharsPerFile: number,
        token?: vscode.CancellationToken
    ): Promise<GitDiffSection> {
        throwIfCancelled(token);

        const untrackedUris = await this.getUntrackedUris(repoPath, repo, token);
        if (untrackedUris.length === 0) {
            return { uri: [], diff: [] };
        }

        // 稳定排序
        untrackedUris.sort((a, b) => a.fsPath.localeCompare(b.fsPath));

        const uri: vscode.Uri[] = [];
        const diff: string[] = [];

        for (const fileUri of untrackedUris) {
            throwIfCancelled(token);

            const repoRelativePath = this.toGitPath(repoPath, fileUri.fsPath);
            if (!repoRelativePath || repoRelativePath.startsWith('..')) {
                continue;
            }

            try {
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                let patch = '';

                if (this.looksBinary(bytes)) {
                    patch = [
                        `diff --git a/${repoRelativePath} b/${repoRelativePath}`,
                        'new file mode 100644',
                        '--- /dev/null',
                        `+++ b/${repoRelativePath}`,
                        'Binary files /dev/null and b/' + repoRelativePath + ' differ'
                    ].join('\n');
                } else {
                    let text = Buffer.from(bytes).toString('utf8');
                    if (text.length > maxCharsPerFile) {
                        text = text.slice(0, maxCharsPerFile) + '\n... [untracked file truncated]';
                    }
                    patch = this.buildNewFileUnifiedDiff(repoRelativePath, text);
                }

                // 确保每个文件的 patch 不超过上限。
                if (patch.length > maxCharsPerFile) {
                    patch = patch.slice(0, maxCharsPerFile) + '\n... [file excerpt truncated]';
                }

                uri.push(fileUri);
                diff.push(patch);
            } catch (e) {
                Logger.warn('[GitService] 读取 untracked 文件失败:', fileUri.fsPath, e);
            }
        }

        return { uri, diff };
    }

    private static async getUntrackedUris(
        repoPath: string,
        repo: Repository,
        token?: vscode.CancellationToken
    ): Promise<vscode.Uri[]> {
        throwIfCancelled(token);

        const out = new Map<string, vscode.Uri>();

        // 1) 主要来源：VS Code Git API 状态
        const untracked = repo.state.untrackedChanges ?? [];
        for (const ch of untracked) {
            out.set(ch.uri.fsPath, ch.uri);
        }

        // 2) 回退方案：某些环境不会填充 `untrackedChanges`，但会在
        // workingTreeChanges 中标记 untracked 文件。
        // 注意：Status 是 VS Code git API 中的枚举，但我们不在运行时导入它。
        // 根据 src/types/git.d.ts 的顺序：
        // - UNTRACKED = 7
        // - INTENT_TO_ADD = 9
        if (out.size === 0) {
            const UNTRACKED = 7;
            const INTENT_TO_ADD = 9;
            const working = repo.state.workingTreeChanges ?? [];
            for (const ch of working) {
                if (ch.status === UNTRACKED || ch.status === INTENT_TO_ADD) {
                    out.set(ch.uri.fsPath, ch.uri);
                }
            }
        }

        // 3) 硬回退方案：直接询问 git（最可靠）
        if (out.size === 0) {
            try {
                if (!this.gitApi) {
                    await this.validateGitExtension();
                }
                const gitPath = this.gitApi?.git.path;
                if (gitPath) {
                    // 使用 -z 避免路径引号问题；解析 NUL 分隔的输出。
                    const { stdout } = await this.execFileAsync(
                        gitPath,
                        ['ls-files', '--others', '--exclude-standard', '-z'],
                        // 请求 Buffer 以避免编码/类型边缘情况。
                        { cwd: repoPath, windowsHide: true, encoding: null }
                    );
                    const buf = stdout as Buffer;
                    const parts = buf
                        .toString('utf8')
                        .split('\0')
                        .map(p => p.trim())
                        .filter(Boolean);
                    for (const p of parts) {
                        const fsPath = path.join(repoPath, p);
                        out.set(fsPath, vscode.Uri.file(fsPath));
                    }
                }
            } catch (e) {
                Logger.warn('[GitService] git ls-files 获取 untracked 失败:', e);
            }
        }

        return [...out.values()];
    }

    /**
     * 获取指定文件的最近 commit 历史（用于生成 commit 消息的上下文）。
     * 说明：这里使用 git log 而不是逐行 git blame，原因是 blame 在未 commit/大改动时
     * 行号映射复杂且开销大；log 的信息对"写出本次 commit 信息"更直接。
     */
    static async getRecentCommitsForFiles(
        repoPath: string,
        files: string[],
        token?: vscode.CancellationToken
    ): Promise<string> {
        throwIfCancelled(token);

        const repo = await this.getRepositoryByPath(repoPath);

        const uniqueFiles = [...new Set(files.map(f => f.trim()).filter(Boolean))];
        const maxFiles = 10;
        const maxCommitsPerFile = 3;
        const selectedFiles = uniqueFiles.slice(0, maxFiles);

        // 跨路径去重（重命名的旧路径/新路径往往共享相同的 commit 历史）。
        const commitMap = new Map<
            string,
            {
                hash: string;
                authorDate?: Date;
                authorName?: string;
                message?: string;
                paths: Set<string>;
            }
        >();

        for (const file of selectedFiles) {
            throwIfCancelled(token);
            const commits = await repo.log({ maxEntries: maxCommitsPerFile, path: file });
            for (const c of commits) {
                const existing = commitMap.get(c.hash);
                if (existing) {
                    existing.paths.add(file);
                    continue;
                }
                commitMap.set(c.hash, {
                    hash: c.hash,
                    authorDate: c.authorDate,
                    authorName: c.authorName,
                    message: c.message,
                    paths: new Set([file])
                });
            }
        }

        const uniqueCommits = [...commitMap.values()].sort((a, b) => {
            const at = a.authorDate?.getTime() ?? 0;
            const bt = b.authorDate?.getTime() ?? 0;
            return bt - at;
        });

        const maxUniqueCommits = maxFiles * maxCommitsPerFile;
        const displayed = uniqueCommits.slice(0, maxUniqueCommits);
        const lines: string[] = [];

        lines.push('Selected files:');
        for (const f of selectedFiles) {
            lines.push(`- ${f}`);
        }
        if (uniqueFiles.length > maxFiles) {
            lines.push(`(and ${uniqueFiles.length - maxFiles} more files...)`);
        }
        lines.push('');

        if (displayed.length === 0) {
            lines.push('Recent commits: (no history found)');
            return lines.join('\n');
        }

        lines.push('Recent commits (touching selected files):');
        for (const c of displayed) {
            const date = c.authorDate ? c.authorDate.toISOString().slice(0, 10) : '';
            const author = c.authorName ?? '';
            const paths = [...c.paths];
            const shownPaths = paths.slice(0, 3);
            const pathSuffix =
                paths.length <= 3 ? shownPaths.join(', ') : `${shownPaths.join(', ')} (+${paths.length - 3} more)`;
            lines.push(`${c.hash.slice(0, 7)} ${date} ${author} | ${c.message ?? ''} [paths: ${pathSuffix}]`.trim());
        }

        if (uniqueCommits.length > maxUniqueCommits) {
            lines.push(`(and ${uniqueCommits.length - maxUniqueCommits} more commits...)`);
        }

        return lines.join('\n');
    }
}
