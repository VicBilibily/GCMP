/*---------------------------------------------------------------------------------------------
 *  Leader 发现文件
 *  Agents 窗体与普通编辑器窗口的 globalState 互相隔离，Agents 窗体无法通过
 *  globalState 参与/获知选举结果。Leader 启动 IPC Server 后把连接信息写入
 *  临时目录下的约定文件，Agents 窗体读取该文件后作为纯客户端连接。
 *  发现文件不在 Leader 卸任时删除：所有权检查与 unlink 无法跨进程原子完成，
 *  旧 Leader 可能误删新 Leader 刚完成原子替换的文件。旧记录连接失败后由调用方重试，
 *  下一任 Leader 启动后会立即发布并持续刷新。
 *  本模块不依赖 vscode，可被 node:test 单元测试直接引用。
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import { resolveLeaderFilePath } from './pathResolver';
import { AtomicJsonFile } from '../usages/atomicJsonFile';

export interface LeaderFileInfo {
    /** Leader 实例 ID */
    instanceId: string;
    /** Leader IPC Server 的监听路径 */
    ipcPath: string;
    /** 文件写入时间戳 */
    updatedAt: number;
}

const LEADER_FILE_REFRESH_INTERVAL_MS = 5000;

/**
 * 读取 Leader 发现文件
 * 文件不存在或内容损坏时返回 undefined，调用方按"暂无 Leader"处理并重试
 */
export function readLeaderFile(filePath: string = resolveLeaderFilePath()): LeaderFileInfo | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<LeaderFileInfo>;
        if (typeof parsed.instanceId !== 'string' || typeof parsed.ipcPath !== 'string') {
            return undefined;
        }
        return {
            instanceId: parsed.instanceId,
            ipcPath: parsed.ipcPath,
            updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
        };
    } catch {
        return undefined;
    }
}

/**
 * 写入 Leader 发现文件（原子写：临时文件 + rename）
 * 仅应由当前 Leader 在 IPC Server 启动成功后调用
 */
export async function writeLeaderFile(info: LeaderFileInfo, filePath: string = resolveLeaderFilePath()): Promise<void> {
    try {
        await AtomicJsonFile.writeJsonAtomically(filePath, info, value => JSON.stringify(value));
    } catch (error) {
        // 保持纯逻辑模块不依赖 vscode 日志（node:test 约束）
        console.warn('[LeaderFile] Failed to write leader file', error);
    }
}

/**
 * 在 IPC Server 存活期间持续发布当前 Leader。
 * 周期刷新可纠正旧 Leader 因 Windows rename 重试而迟到覆盖的新记录。
 */
export class LeaderFilePublisher {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = true;
    private refreshPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly instanceId: string,
        private readonly ipcPath: string,
        private readonly filePath: string = resolveLeaderFilePath(),
        private readonly refreshIntervalMs: number = LEADER_FILE_REFRESH_INTERVAL_MS
    ) {}

    async start(): Promise<void> {
        if (!this.stopped) {
            return;
        }
        this.stopped = false;
        await this.refresh();
        this.scheduleRefresh();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        await this.refreshPromise;
    }

    private async refresh(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.refreshPromise = writeLeaderFile(
            {
                instanceId: this.instanceId,
                ipcPath: this.ipcPath,
                updatedAt: Date.now()
            },
            this.filePath
        );
        await this.refreshPromise;
    }

    private scheduleRefresh(): void {
        if (this.stopped) {
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.refresh().then(() => this.scheduleRefresh());
        }, this.refreshIntervalMs);
    }
}
