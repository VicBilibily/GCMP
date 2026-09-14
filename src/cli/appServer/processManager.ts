/*---------------------------------------------------------------------------------------------
 *  Codex App Server 进程管理
 *  负责 codex 可执行文件探测（Windows 下解析 shim→真实 exe）、懒启动 spawn、
 *  代理环境变量注入、stderr 回收、空闲回收、崩溃重启与熔断
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess, execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Logger } from '../../utils/runtime/logger';
import { ConfigManager } from '../../utils/config/configManager';
import { NO_PROXY_SENTINEL } from '../../utils/net/proxyAgent';
import type { CodexAppServerConfig } from './type';

/** 连续崩溃熔断窗口 */
const CRASH_WINDOW_MS = 5 * 60 * 1000;
const CRASH_THRESHOLD = 3;

/** 解析结果：可执行文件 + 是否需要 shell 包装（.cmd shim） */
export interface CodexBinaryResolution {
    command: string;
    useShell: boolean;
}

/**
 * 探测 codex 可执行文件。
 * 优先显式配置；否则 PATH 查找。仅 Windows 的 .cmd/.bat shim 需要 shell 包装
 * （并尽量解析到 Volta/npm 布局下的真实 exe）；POSIX 下 which 结果直接可执行。
 */
export function resolveCodexBinary(configuredPath?: string): CodexBinaryResolution | undefined {
    if (configuredPath && fs.existsSync(configuredPath)) {
        return { command: configuredPath, useShell: isWindowsCmdShim(configuredPath) };
    }
    const whereCmd = process.platform === 'win32' ? 'where.exe' : 'which';
    let output: string;
    try {
        output = execFileSync(whereCmd, ['codex'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true
        }).trim();
    } catch {
        return undefined;
    }
    const candidates = output
        .split(/\r?\n/)
        .map(s => s.trim())
        .filter(Boolean);
    if (candidates.length === 0) {
        return undefined;
    }

    if (process.platform !== 'win32') {
        // POSIX：内核自动跟随符号链接；realpath 仅用于解析出真实二进制便于日志诊断
        let command = candidates[0];
        try {
            command = fs.realpathSync(command);
        } catch {
            // 保留原路径
        }
        return { command, useShell: false };
    }

    // Windows：优先 .exe；其次 .cmd shim 解析到真实 exe；兜底 shell 包装
    const exe = candidates.find(c => c.toLowerCase().endsWith('.exe'));
    if (exe) {
        return { command: exe, useShell: false };
    }
    const shim = candidates.find(c => isWindowsCmdShim(c)) ?? candidates[0];
    const resolved = resolveShimToRealExe(shim);
    if (resolved) {
        return { command: resolved, useShell: false };
    }
    return { command: shim, useShell: isWindowsCmdShim(shim) };
}

/** Windows 的 .cmd/.bat shim 需要 shell 包装才能 spawn */
function isWindowsCmdShim(commandPath: string): boolean {
    if (process.platform !== 'win32') {
        return false;
    }
    const lower = commandPath.toLowerCase();
    return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * 把 codex.cmd shim 解析为真实 codex.exe。
 * 覆盖 Volta（tools/image/packages/@openai/codex/.../bin/codex.exe）与
 * 全局 npm（npm/node_modules/@openai/codex/...）两类常见布局；解析失败返回 undefined。
 */
function resolveShimToRealExe(shimPath: string): string | undefined {
    if (process.platform !== 'win32' || !shimPath.toLowerCase().endsWith('.cmd')) {
        return undefined;
    }
    try {
        const binDir = path.dirname(shimPath);
        // Volta：bin 目录同级无 node_modules，真实 exe 在 tools/image/packages 下
        if (/[\\/]volta[\\/]bin$/i.test(binDir)) {
            const packagesDir = path.join(path.dirname(binDir), 'tools', 'image', 'packages', '@openai', 'codex');
            const found = findCodexExeUnder(packagesDir);
            if (found) {
                return found;
            }
        }
        // 全局 npm：bin 目录下直接有 node_modules
        const npmModules = path.join(binDir, 'node_modules', '@openai', 'codex');
        const found = findCodexExeUnder(npmModules);
        if (found) {
            return found;
        }
    } catch {
        // 探测失败走 shim + shell 兜底
    }
    return undefined;
}

/**
 * 在 @openai/codex 包目录下找 codex.exe（限定 vendor 路径防止误匹配）。
 * 递归下钻 node_modules/@openai（Volta 存在 codex/node_modules/@openai/codex-win32-x64 双层嵌套）。
 */
function findCodexExeUnder(packageDir: string): string | undefined {
    const suffix = path.join('vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    const walk = (dir: string, depth: number): string | undefined => {
        if (depth < 0 || !fs.existsSync(dir)) {
            return undefined;
        }
        const direct = path.join(dir, suffix);
        if (fs.existsSync(direct)) {
            return direct;
        }
        const nested = path.join(dir, 'node_modules', '@openai');
        if (fs.existsSync(nested)) {
            for (const sub of fs.readdirSync(nested)) {
                const found = walk(path.join(nested, sub), depth - 1);
                if (found) {
                    return found;
                }
            }
        }
        return undefined;
    };
    return walk(packageDir, 4);
}

/** 按 gcmp.proxy 语义构建 spawn 环境变量（reqwest 吃 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY） */
export function buildSpawnEnv(providerKey = 'codex'): NodeJS.ProcessEnv {
    const env = { ...process.env };
    const proxy = ConfigManager.resolveProxyForModel(undefined, providerKey);
    if (proxy && proxy !== NO_PROXY_SENTINEL) {
        env.HTTP_PROXY = proxy;
        env.HTTPS_PROXY = proxy;
        env.ALL_PROXY = proxy;
    }
    return env;
}

export interface SpawnedAppServer {
    proc: ChildProcess;
    resolution: CodexBinaryResolution;
}

/**
 * App Server 子进程生命周期管理：懒启动、崩溃计数熔断、空闲回收。
 * 不直接实现协议——协议层见 client.ts。
 */
export class CodexAppServerProcessManager {
    private spawned?: SpawnedAppServer;
    private crashTimestamps: number[] = [];
    private idleTimer?: NodeJS.Timeout;
    private onExitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
    private stderrBuffer = '';

    constructor(private readonly getConfig: () => CodexAppServerConfig) {}

    get isRunning(): boolean {
        return !!this.spawned && this.spawned.proc.exitCode === null && !this.spawned.proc.killed;
    }

    onExit(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void {
        this.onExitHandlers.push(handler);
    }

    /** 懒启动：已在运行则复用；崩溃熔断期内抛错 */
    ensureRunning(): SpawnedAppServer {
        if (this.isRunning) {
            this.touchIdleTimer();
            return this.spawned!;
        }
        this.assertNotCircuitBroken();
        const config = this.getConfig();
        const resolution = resolveCodexBinary(config.codexBinary);
        if (!resolution) {
            throw new Error(
                'Codex CLI not found in PATH. Install codex-cli and sign in, or set gcmp.providerOverrides.codex.appServer.codexBinary.'
            );
        }
        const args = ['app-server', '--listen', 'stdio://'];
        Logger.info(
            `[CodexAppServer] spawning: ${resolution.command} ${args.join(' ')} (shell=${resolution.useShell})`
        );
        const proc = spawn(resolution.command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: resolution.useShell,
            env: buildSpawnEnv('codex')
        });
        proc.stderr?.setEncoding('utf8');
        proc.stderr?.on('data', (chunk: string) => {
            this.stderrBuffer = (this.stderrBuffer + chunk).slice(-8192);
            Logger.trace(`[CodexAppServer stderr] ${chunk.trimEnd()}`);
        });
        proc.on('exit', (code, signal) => {
            Logger.warn(`[CodexAppServer] exited: code=${code} signal=${signal}`);
            this.recordCrash();
            this.spawned = undefined;
            this.clearIdleTimer();
            for (const h of this.onExitHandlers) {
                h(code, signal);
            }
        });
        this.spawned = { proc, resolution };
        this.touchIdleTimer();
        return this.spawned;
    }

    /** 进程退出后的最近 stderr 片段，用于错误诊断 */
    getRecentStderr(): string {
        return this.stderrBuffer;
    }

    private recordCrash(): void {
        const now = Date.now();
        this.crashTimestamps = this.crashTimestamps.filter(ts => now - ts < CRASH_WINDOW_MS);
        this.crashTimestamps.push(now);
    }

    private assertNotCircuitBroken(): void {
        const now = Date.now();
        this.crashTimestamps = this.crashTimestamps.filter(ts => now - ts < CRASH_WINDOW_MS);
        if (this.crashTimestamps.length >= CRASH_THRESHOLD) {
            throw new Error(
                `Codex app-server crashed ${this.crashTimestamps.length} times within 5 minutes; ` +
                    'circuit open. Check codex CLI installation or switch transport back to "direct".'
            );
        }
    }

    private touchIdleTimer(): void {
        this.clearIdleTimer();
        const minutes = this.getConfig().idleShutdownMinutes ?? 10;
        if (minutes <= 0) {
            return; // 常驻
        }
        this.idleTimer = setTimeout(
            () => {
                Logger.info(`[CodexAppServer] idle for ${minutes}min, shutting down`);
                this.shutdown();
            },
            minutes * 60 * 1000
        );
        this.idleTimer.unref?.();
    }

    private clearIdleTimer(): void {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = undefined;
        }
    }

    /** 优雅退出；Windows 下 shell 包装时需 taskkill 杀进程树 */
    shutdown(): void {
        const spawned = this.spawned;
        this.spawned = undefined;
        this.clearIdleTimer();
        if (!spawned) {
            return;
        }
        try {
            if (spawned.resolution.useShell && process.platform === 'win32' && spawned.proc.pid) {
                spawn('taskkill', ['/pid', String(spawned.proc.pid), '/t', '/f'], {
                    stdio: 'ignore',
                    windowsHide: true
                });
            } else {
                spawned.proc.kill();
            }
        } catch (error) {
            Logger.warn(`[CodexAppServer] shutdown error: ${error}`);
        }
    }

    dispose(): void {
        this.shutdown();
        this.onExitHandlers = [];
    }
}
