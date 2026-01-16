/*---------------------------------------------------------------------------------------------
 *  CommitMessage
 *  UI 协调器：负责进度展示、仓库选择、写入输入框与提示反馈。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { GitService } from './gitService';
import { GeneratorService } from './generatorService';
import {
    UserCancelledError,
    NoChangesDetectedError,
    NoRepositoriesFoundError,
    GitExtensionNotFoundError,
    ModelNotFoundError
} from './types';
import { Logger } from '../utils';
import { Repository } from '../types/git';

/**
 * CommitMessage - 提交消息生成的 UI 协调器。
 */
export class CommitMessage {
    private static isGenerating: boolean = false;

    private static normalizeFsPath(p: string): string {
        // Windows 下 fsPath 大小写不敏感，做一次规范化方便匹配。
        const normalized = path
            .normalize(p)
            .replace(/[\\/]+/g, path.sep)
            .toLowerCase();

        // 去掉末尾分隔符（保留盘符根目录，如 c:\）
        let out = normalized;
        while (out.length > 3 && out.endsWith(path.sep)) {
            out = out.slice(0, -1);
        }
        return out;
    }

    private static isSameOrChildPath(target: string, root: string): boolean {
        if (target === root) {
            return true;
        }
        if (!target.startsWith(root)) {
            return false;
        }
        const next = target.charAt(root.length);
        return next === path.sep;
    }

    private static throwIfCancelled(token: vscode.CancellationToken): void {
        if (token.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
    }

    /**
     * 生成并设置提交消息（主入口）。
     *
     * 职责说明：
     * - UI 协调：进度展示、仓库选择、写入 Git 输入框、提示反馈
     * - 业务流程：在本类内完成（diff/blame/生成），避免跨文件跳转
     *
     * 参数：
     * - sourceControlRepository：VS Code Git 扩展传入的仓库对象；若未传入则会自动选择（单仓库直接取，多仓库按 resContext 尝试匹配，否则弹出选择）。
     * - options.scope：控制分析范围
     *   - 'config'：默认行为（分析 staged + working tree）
     *   - 'staged'：仅分析已暂存（staged）
     *   - 'workingTree'：仅分析工作区变更（tracked + untracked），不包含 staged
     * - options.resContext：SCM 菜单/按钮回调常带的 ResourceGroup，用于多仓库场景推断当前仓库。
     *
     * 取消：
     * - 进度通知支持取消；取消会抛出 vscode.CancellationError 并被静默处理。
     */
    static async generateAndSetCommitMessage(
        sourceControlRepository?: Repository,
        options?: { scope?: 'config' | 'staged' | 'workingTree'; resContext?: vscode.SourceControlResourceGroup }
    ): Promise<void> {
        if (this.isGenerating) {
            vscode.window.showInformationMessage('正在生成提交消息，请稍候或点击“停止”中止');
            return;
        }

        this.isGenerating = true;

        try {
            // 进度展示应尽早开始，避免点击后出现“无响应”的感知延迟
            await this.executeWithProgress(async (progress, token) => {
                // 1. 初始化和验证
                progress.report({ message: '正在初始化...', increment: 2 });
                await this.initializeAndValidate();
                this.throwIfCancelled(token);

                // 2. 选择仓库
                progress.report({ message: '正在选择仓库...', increment: 3 });
                if (!sourceControlRepository) {
                    const repos = await GitService.getRepositories();
                    this.throwIfCancelled(token);

                    // 只有一个仓库时直接使用它，避免不必要的路径推断。
                    if (repos.length === 1) {
                        sourceControlRepository = repos[0];
                    } else {
                        // SCM 菜单（title/resourceGroup/title 等）通常会把当前 SourceControl/ResourceGroup 作为参数传入。
                        // SourceControlResourceGroup 没有 rootUri/provider，但 resourceStates 里有 resourceUri。
                        // 通过第一个资源的 resourceUri.fsPath 推断当前仓库。
                        const first = options?.resContext?.resourceStates?.[0];
                        const fsPath = first?.resourceUri?.fsPath;
                        const rootFsPath = typeof fsPath === 'string' && fsPath.trim() ? fsPath.trim() : undefined;
                        if (rootFsPath) {
                            const target = this.normalizeFsPath(rootFsPath);
                            const matched = repos
                                .map(r => ({ r, root: this.normalizeFsPath(r.rootUri.fsPath) }))
                                // rootFsPath 既可能是 repo root，也可能是某个变更文件路径。
                                .filter(x => this.isSameOrChildPath(target, x.root))
                                // 嵌套仓库时选择路径更长（更具体）的那个。
                                .sort((a, b) => b.root.length - a.root.length)[0]?.r;
                            if (matched) {
                                sourceControlRepository = matched;
                            }
                        }

                        if (!sourceControlRepository) {
                            sourceControlRepository = await GitService.selectRepository(repos);
                        }
                    }
                }

                this.throwIfCancelled(token);

                // 3. 生成提交消息
                const commitMessage = await this.generateCommitMessage(
                    progress,
                    sourceControlRepository!,
                    token,
                    options?.scope
                );
                this.throwIfCancelled(token);

                // 4. 应用提交消息
                progress.report({ message: '正在应用提交消息...', increment: 10 });
                sourceControlRepository!.inputBox.value = commitMessage.message;
                vscode.window.showInformationMessage('提交消息已生成并填入输入框');

                Logger.info(`[CommitMessage] 提交消息已生成: ${commitMessage.message.substring(0, 50)}...`);
            });
        } catch (error: unknown) {
            await this.handleError(error);
        } finally {
            this.isGenerating = false;
        }
    }

    /**
     * 初始化和验证
     */
    private static async initializeAndValidate(): Promise<void> {
        if (!vscode.workspace.workspaceFolders) {
            throw new Error('没有打开的工作区');
        }
        // 验证 Git 扩展
        await GitService.validateGitExtension();
    }

    /**
     * 业务流程：生成提交消息（diff/blame/生成）。
     */
    private static async generateCommitMessage(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        repository: Repository,
        token: vscode.CancellationToken,
        scope: 'config' | 'staged' | 'workingTree' = 'config'
    ): Promise<{ message: string; model: string }> {
        const repoPath = repository.rootUri.fsPath;
        // 仅 staged 入口才启用 staged-only；默认入口始终分析完整变更（staged + working tree）。
        const onlyStagedChanges = scope === 'staged';

        // 1. 获取 Git 变更
        progress.report({ message: '正在分析 Git 变更...', increment: 10 });
        let diffParts = await GitService.getDiff(repoPath, onlyStagedChanges, token);

        // 触发来源为“变更区（working tree）”时：只分析 working tree（tracked + untracked），不包含 staged。
        if (scope === 'workingTree') {
            diffParts = {
                staged: { uri: [], diff: [] },
                tracked: diffParts.tracked,
                untracked: diffParts.untracked
            };
        }
        this.throwIfCancelled(token);

        // 2. Git Blame 分析（历史上下文）
        progress.report({ message: '正在分析代码历史...', increment: 10 });
        const blameAnalysis = await this.analyzeChanges(repoPath, diffParts, token);
        this.throwIfCancelled(token);

        // 3. 生成提交消息
        const commitMessage = await GeneratorService.generateCommitMessages(diffParts, blameAnalysis, progress, token);
        this.throwIfCancelled(token);

        return commitMessage;
    }

    /**
     * 分析代码变更的历史（用于提供上下文）。
     */
    private static async analyzeChanges(
        repoPath: string,
        diffParts: Awaited<ReturnType<typeof GitService.getDiff>>,
        token: vscode.CancellationToken
    ): Promise<string> {
        try {
            const toRepoRelative = (u: vscode.Uri): string => {
                const rel = path.relative(repoPath, u.fsPath);
                return rel.split(path.sep).join('/');
            };

            const trackedFiles = [...diffParts.staged.uri, ...diffParts.tracked.uri]
                .map(toRepoRelative)
                .map(p => p.trim())
                .filter(p => p && !p.startsWith('..'));

            const untrackedFiles = diffParts.untracked.uri
                .map(toRepoRelative)
                .map(p => p.trim())
                .filter(p => p && !p.startsWith('..'));

            const trackedUnique = [...new Set(trackedFiles)];
            const untrackedUnique = [...new Set(untrackedFiles)];

            if (trackedUnique.length === 0 && untrackedUnique.length === 0) {
                return 'No files to analyze';
            }

            // 将“未跟踪的新文件”和“历史上下文”拆开：
            // - untracked 文件本身没有 HEAD 历史，混入会导致上下文噪音
            // - tracked 文件才需要拉取最近提交历史
            const lines: string[] = [];
            if (trackedUnique.length > 0) {
                lines.push('Changed files (tracked):');
                lines.push(`- ${trackedUnique.join('\n- ')}`);
            }

            if (untrackedUnique.length > 0) {
                if (lines.length > 0) {
                    lines.push('');
                }
                lines.push('Untracked new files:');
                lines.push(`- ${untrackedUnique.join('\n- ')}`);
            }

            if (trackedUnique.length > 0) {
                const history = await GitService.getRecentCommitsForFiles(repoPath, trackedUnique, token);
                lines.push('');
                lines.push('Recent commits (HEAD, tracked files only):');
                lines.push(history);
            }

            return lines.join('\n').trim();
        } catch (error) {
            Logger.warn('[CommitMessage] Blame 分析失败:', error);
            return 'Blame analysis not available';
        }
    }

    /**
     * 执行带进度显示的操作
     */
    private static async executeWithProgress(
        action: (
            progress: vscode.Progress<{ message?: string; increment?: number }>,
            token: vscode.CancellationToken
        ) => Promise<void>
    ): Promise<void> {
        // 双通道进度展示：
        // - SCM 视图显示进行中进度条（不支持 title/message/cancel）
        // - 通知弹窗显示可取消的详细进度信息
        await vscode.window.withProgress({ location: vscode.ProgressLocation.SourceControl }, async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'GCMP Commit',
                    cancellable: true
                },
                async (progress, token) => {
                    await action(progress, token);
                }
            );
        });
    }

    /**
     * 处理错误
     */
    private static async handleError(error: unknown): Promise<void> {
        // 用户取消 - 静默处理
        if (error instanceof UserCancelledError) {
            Logger.trace('[CommitMessage] 用户取消操作');
            return;
        }
        // VS Code 取消
        if (error instanceof vscode.CancellationError) {
            Logger.trace('[CommitMessage] 操作被取消');
            return;
        }
        // 无变更
        if (error instanceof NoChangesDetectedError) {
            vscode.window.showWarningMessage('没有检测到需要提交的变更');
            return;
        }
        // 无仓库
        if (error instanceof NoRepositoriesFoundError) {
            vscode.window.showWarningMessage('没有找到 Git 仓库');
            return;
        }
        // Git 扩展未找到
        if (error instanceof GitExtensionNotFoundError) {
            vscode.window.showErrorMessage('Git 扩展未找到或未激活');
            return;
        }
        // 模型未找到
        if (error instanceof ModelNotFoundError) {
            vscode.window.showErrorMessage(error.message);
            return;
        }
        // 其他错误
        const errorMessage = error instanceof Error ? error.message : String(error);
        Logger.error('[CommitMessage] 生成失败:', error);
        vscode.window.showErrorMessage(`生成提交消息失败: ${errorMessage}`);
    }
}
