/*---------------------------------------------------------------------------------------------
 *  IPC 路径解析器
 *  根据当前操作系统生成 Unix Domain Socket 或 Windows Named Pipe 路径
 *--------------------------------------------------------------------------------------------*/

import * as os from 'node:os';
import * as path from 'node:path';

const EXTENSION_SAFE_NAME = 'gcmp';
const MAX_UNIX_IPC_PATH_LENGTH = 104; // macOS 实际限制为 104（含终止符），比 Linux 108 更严格

/**
 * 获取当前用户的唯一标识，用于隔离多用户场景下的 IPC 路径
 */
function getUserIdentifier(): string {
    // 使用用户名/UID 进行隔离
    const username = os.userInfo().username;
    const uid = process.platform === 'win32' ? process.env.USERNAME : `${os.userInfo().uid}`;
    const raw = username || uid || 'unknown';
    // 只保留安全字符
    return raw.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * 获取一致的临时目录
 * 优先使用 /tmp（macOS/Linux 上所有用户会话共享），避免不同实例间 os.tmpdir() 因环境变量不一致而分叉
 */
function getSharedTempDir(): string {
    if (process.platform !== 'win32' && process.env.TMPDIR !== '/tmp') {
        // 显式返回系统级 /tmp，保证多实例、Sandbox 内外路径一致
        return '/tmp';
    }
    return os.tmpdir();
}

/**
 * 根据 Leader 实例 ID 解析 IPC 路径
 * @param leaderId Leader 实例 ID
 * @returns Windows 返回 Named Pipe 路径；Unix/macOS 返回 Unix Domain Socket 路径
 */
export function resolveIpcPath(leaderId: string): string {
    const userId = getUserIdentifier();
    // 取 leaderId 前 16 个字符作为安全 ID，既能唯一区分实例，又控制路径长度
    const safeLeaderId = leaderId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 16);
    const pipeName = `${EXTENSION_SAFE_NAME}-${userId}-${safeLeaderId}`;

    if (process.platform === 'win32') {
        // Windows Named Pipe 必须以 \\.\pipe\ 开头
        return `\\\\.\\pipe\\${pipeName}`;
    }

    // Unix / macOS：使用共享临时目录，避免路径过长（macOS 限制 104 字节）
    return path.join(getSharedTempDir(), `${pipeName}.sock`);
}

/**
 * 判断给定路径是否为 Windows Named Pipe 路径
 */
export function isNamedPipePath(pipePath: string): boolean {
    return pipePath.startsWith('\\\\.\\pipe\\');
}

/**
 * 获取 IPC 路径的最大允许长度
 */
export function getMaxIpcPathLength(): number {
    return process.platform === 'win32' ? 256 : MAX_UNIX_IPC_PATH_LENGTH;
}

/**
 * 验证 IPC 路径长度是否安全
 */
export function isIpcPathLengthSafe(pipePath: string): boolean {
    return Buffer.byteLength(pipePath, 'utf8') <= getMaxIpcPathLength();
}
