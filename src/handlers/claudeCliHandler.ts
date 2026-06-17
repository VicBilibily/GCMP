/*---------------------------------------------------------------------------------------------
 *  Claude Code CLI 子进程处理器
 *  管理 claude 子进程的生命周期、stream-json 事件流解析
 *  支持多轮工具调用循环（外部由 ClaudeProvider 控制）
 *
 *  通信模式：
 *    GCMP → spawn claude --disallowedTools ALL --max-turns 1 --model ... -p ""
 *    stdin:  JSON.stringify([{role, content}])  ← Anthropic Messages 格式
 *    stdout: NDJSON stream-json 事件
 *              system  → 初始化信息（模型、工具列表、MCP 服务器）
 *              assistant → 回复消息（含 text / tool_use / thinking content blocks）
 *              result   → 最终结果（含 usage, cost, 耗时）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcess } from 'child_process';
import { createInterface } from 'readline';
import { Logger } from '../utils/logger';
import { isNoProxyValue } from '../utils/proxyAgent';

/** 所有禁用工具列表（与 Cline 保持一致） */
const ALL_DISALLOWED = [
    'Task',
    'TaskOutput',
    'Bash',
    'Glob',
    'Grep',
    'Read',
    'Edit',
    'Write',
    'NotebookEdit',
    'WebFetch',
    'TodoWrite',
    'WebSearch',
    'TaskStop',
    'AskUserQuestion',
    'Skill',
    'EnterPlanMode',
    'ExitPlanMode',
    'EnterWorktree',
    'ExitWorktree',
    'CronCreate',
    'CronDelete',
    'CronList',
    'ToolSearch',
    'ScheduleWakeup'
].join(',');

/** Stream-JSON 事件类型 */
export type StreamJsonEvent = Record<string, unknown>;

/** 解析后的 assistant 回复 */
export interface ClaudeAssistantMessage {
    model: string;
    content: ClaudeContentBlock[];
    usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    stop_reason: string | null;
}

/** 回复中的内容块类型 */
export type ClaudeContentBlock =
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'tool_use'; name: string; input: unknown; id: string }
    | { type: 'redacted_thinking'; data?: string };

/** 最终结果 */
export interface ClaudeResult {
    result: string;
    stop_reason: string;
    total_cost_usd: number;
    duration_ms: number;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
    session_id: string;
    is_error: boolean;
}

/** Handler 配置 */
export interface ClaudeCliHandlerOptions {
    /** System prompt (含工具定义) */
    systemPrompt: string;
    /** Anthropic 格式消息列表 */
    messages: Array<{ role: string; content: Array<{ type: string; [key: string]: unknown }> }>;
    /** 模型 ID（直接传给 --model） */
    modelId: string;
    /** 思考预算 token */
    thinkingBudgetTokens?: number;
    /** 超时时间（毫秒，默认 180s） */
    timeoutMs?: number;
    /** 代理 URL */
    proxyUrl?: string;
}

/** Handler 输出事件 */
export type ClaudeCliOutput =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; reasoning: string }
    | { type: 'tool_use'; name: string; input: unknown; id: string }
    | {
          type: 'usage';
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
          totalCost?: number;
      }
    | { type: 'error'; message: string }
    | { type: 'done' };

/**
 * Claude Code CLI Handler
 * 管理子进程生命周期与 stream-json 事件流
 */
export class ClaudeCliHandler {
    private proc: ChildProcess | null = null;
    private abortController: AbortController | null = null;

    /**
     * 发送请求并返回事件流（异步生成器）
     * 每个 yield 代表一个输出块
     */
    async *processRequest(
        options: ClaudeCliHandlerOptions,
        token?: vscode.CancellationToken
    ): AsyncGenerator<ClaudeCliOutput> {
        this.abortController = new AbortController();

        const timeoutMs = options.timeoutMs ?? 180_000;
        const claudePath = this.resolveClaudePath();
        const shouldUseFile = os.platform() === 'win32' || options.systemPrompt.length > 65536;

        let systemPrompt = options.systemPrompt;
        let systemPromptFile: string | undefined;

        try {
            // Windows 或长文本使用临时文件
            if (shouldUseFile) {
                const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-claude-'));
                systemPromptFile = path.join(tmpDir, 'system-prompt.txt');
                fs.writeFileSync(systemPromptFile, systemPrompt, 'utf-8');
            }

            // 构建 CLI 参数
            const args = this.buildArgs({
                systemPrompt,
                systemPromptFile,
                modelId: options.modelId,
                thinkingBudgetTokens: options.thinkingBudgetTokens,
                shouldUseFile
            });

            // 构建环境变量
            const env = this.buildEnv(options.proxyUrl, options.thinkingBudgetTokens);

            Logger.debug(`[ClaudeCLI] Spawning: ${claudePath} ${args.slice(0, 6).join(' ')} ...`);

            // spawn 子进程
            const proc = spawn(claudePath, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true, // Windows 需要 shell 来解析 .cmd
                env,
                windowsHide: true
            });
            this.proc = proc;

            // 超时
            const timeout = setTimeout(() => {
                Logger.warn(`[ClaudeCLI] Request timed out after ${timeoutMs}ms`);
                this.kill();
            }, timeoutMs);

            // 监听取消
            const cancelHandler = token?.onCancellationRequested(() => {
                Logger.debug('[ClaudeCLI] Cancellation requested');
                this.kill();
            });

            // 收集 stderr（用于调试）
            const stderrChunks: string[] = [];
            proc.stderr?.on('data', (chunk: Buffer) => {
                stderrChunks.push(chunk.toString());
            });

            // 写入 messages（Anthropic Messages JSON 数组）
            const messagesJson = JSON.stringify(options.messages);
            proc.stdin?.write(messagesJson);
            proc.stdin?.end();

            // 使用 readline 逐行收集 stdout NDJSON
            const lines: string[] = [];
            const rl = createInterface({ input: proc.stdout! });
            rl.on('line', (line: string) => {
                const t = line.trim();
                if (t) lines.push(t);
            });

            // 等待进程结束（close 事件确保 stdout 已全部读取完毕）
            const exitCode = await new Promise<number | null>(resolve => {
                proc.on('close', resolve);
            });

            // 清理超时和取消监听
            clearTimeout(timeout);
            if (cancelHandler) {
                cancelHandler.dispose();
            }

            // 解析所有已收集的行
            let processState: { partialData: string | null } = { partialData: null };
            let foundText = false;
            for (const trimmed of lines) {
                const event = this.parseEvent(trimmed, processState);
                if (!event) continue;

                if (event.type === 'assistant' && (event as any).message) {
                    const msg = (event as any).message as ClaudeAssistantMessage;
                    if (!msg.content) continue;
                    for (const block of msg.content) {
                        if (block.type === 'text') {
                            foundText = true;
                            yield { type: 'text', text: block.text };
                        }
                    }
                } else if (event.type === 'result' && (event as any).result !== undefined) {
                    const raw = event as Record<string, unknown>;
                    if (raw.is_error) {
                        yield { type: 'error', message: String(raw.result) };
                    } else {
                        const resultText = String(raw.result || '');
                        if (resultText) {
                            foundText = true;
                            yield { type: 'text', text: resultText };
                        }
                    }
                }
            }

            // 检查退出码
            if (exitCode !== null && exitCode !== 0) {
                const stderr = stderrChunks.join('').trim();
                yield {
                    type: 'error',
                    message: `claude process exited with code ${exitCode}.${stderr ? ` stderr: ${stderr}` : ''}`
                };
            }

            // 若没有找到任何文本但有 events，debug 输出
            if (!foundText && lines.length > 0) {
                Logger.debug(`[ClaudeCLI] No text found in ${lines.length} events`);
                // 尝试输出第一个 event 的类型
                const first = lines[0];
                Logger.debug(`[ClaudeCLI] First line: ${first.substring(0, 200)}`);
            }

            yield { type: 'done' };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            Logger.error(`[ClaudeCLI] Error: ${message}`);
            yield { type: 'error', message };
            yield { type: 'done' };
        } finally {
            // 清理临时文件
            if (systemPromptFile) {
                try {
                    fs.unlinkSync(systemPromptFile);
                    fs.rmdirSync(path.dirname(systemPromptFile));
                } catch {
                    /* ignore */
                }
            }
            this.cleanup();
        }
    }

    /**
     * 强制终止子进程
     */
    kill(): void {
        if (this.proc && !this.proc.killed) {
            this.proc.kill('SIGTERM');
            // 1 秒后强制 kill
            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    this.proc.kill('SIGKILL');
                }
            }, 1000);
        }
        this.abortController?.abort();
    }

    private cleanup(): void {
        this.proc = null;
        this.abortController = null;
    }

    /**
     * 构建 CLI 参数
     */
    private buildArgs(opts: {
        systemPrompt: string;
        systemPromptFile?: string;
        modelId: string;
        thinkingBudgetTokens?: number;
        shouldUseFile: boolean;
    }): string[] {
        const args: string[] = [];

        if (opts.shouldUseFile && opts.systemPromptFile) {
            args.push('--system-prompt-file', opts.systemPromptFile);
        } else {
            args.push('--system-prompt', opts.systemPrompt);
        }

        args.push(
            '--output-format',
            'stream-json',
            '--disallowedTools',
            ALL_DISALLOWED,
            '--max-turns',
            '1',
            '--model',
            opts.modelId,
            '-p',
            ''
        );

        return args;
    }

    /**
     * 构建进程环境变量
     */
    private buildEnv(proxyUrl?: string, thinkingBudgetTokens?: number): NodeJS.ProcessEnv {
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            CLAUDE_TERMINAL_WIDTH: '120',
            CLI_COLOR: '0',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_NON_ESSENTIAL_MODEL_CALLS: '1'
        };

        // 思考预算（转为环境变量）
        if (thinkingBudgetTokens && thinkingBudgetTokens > 0) {
            env.MAX_THINKING_TOKENS = String(thinkingBudgetTokens);
        }

        // 删除 ANTHROPIC_API_KEY，让 CLI 使用本地凭证
        delete env.ANTHROPIC_API_KEY;

        // 代理设置
        if (proxyUrl) {
            if (isNoProxyValue(proxyUrl)) {
                env.NO_PROXY = '*';
                env.no_proxy = '*';
                ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'].forEach(
                    k => delete env[k]
                );
            } else {
                env.HTTP_PROXY = proxyUrl;
                env.HTTPS_PROXY = proxyUrl;
                env.http_proxy = proxyUrl;
                env.https_proxy = proxyUrl;
            }
        }

        return env;
    }

    /**
     * 解析 stream-json 事件行
     */
    private parseEvent(line: string, state: { partialData: string | null }): StreamJsonEvent | null {
        // 处理 partial data
        if (state.partialData) {
            state.partialData += line;
            try {
                const event = JSON.parse(state.partialData);
                state.partialData = null;
                return event;
            } catch {
                return null;
            }
        }

        try {
            return JSON.parse(line);
        } catch {
            // 可能是不完整的 JSON，存起来等下一行
            state.partialData = line;
            return null;
        }
    }

    /**
     * 解析 claude 命令路径
     */
    private resolveClaudePath(): string {
        return 'claude';
    }
}
