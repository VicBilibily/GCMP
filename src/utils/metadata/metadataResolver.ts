/*---------------------------------------------------------------------------------------------
 *  GCMP 远程元数据（纯逻辑层）
 *  载荷解析/字段级校验、内存快照与内置兜底合并
 *  不依赖 vscode，可供 node:test 单测及 cliUserAgent 等纯逻辑模块消费
 *--------------------------------------------------------------------------------------------*/

import type { ProviderConfig } from '../../types/sharedTypes';
// 内置兜底与远程发布共用同一源文件：扩展打包时内联此 JSON，website 构建时同步到 public/ 供 Pages 分发
import builtinMetadata from './gcmp-metadata.json';
import { hashCliMetadata } from './cliMetadataHash';

export { hashCliMetadata };

/** 远程/本地元数据的 cli 分组（字段均可选，缺失时走内置兜底） */
export interface GcmpCliMetadata {
    /** Claude Code CLI 仿真版本（用于 claude-cli UA） */
    claudeCodeVersion?: string;
    /** codex-tui 仿真版本（用于 codex UA 与 client_version 参数） */
    codexTuiVersion?: string;
    /** codex-tui originator 标识 */
    codexTuiOriginator?: string;
}

/** 远程元数据载荷（嵌套分组结构） */
export interface GcmpMetadata {
    schemaVersion: number;
    /** 内容哈希（cli 分组的版本标识，仅作展示/区分，不参与新鲜度判定） */
    contentHash?: string;
    cli: GcmpCliMetadata;
}

const SUPPORTED_SCHEMA_VERSION = 1;

function asNonEmptyString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** CLI 仿真版本字段：限定三段数字开头的版本串，拒绝换行等请求头非法字符（远程值会拼接进 UA） */
function asCliVersion(value: unknown): string | undefined {
    const version = asNonEmptyString(value);
    return version && /^\d+\.\d+\.\d+[-.\w]*$/.test(version) ? version : undefined;
}

/** originator 会展开进 HTTP 头，仅允许标识符字符 */
function asCliOriginator(value: unknown): string | undefined {
    const originator = asNonEmptyString(value);
    return originator && /^[A-Za-z0-9._-]+$/.test(originator) ? originator : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * 解析远程元数据文本
 * schemaVersion 不受支持或 JSON 非法时整体拒绝（返回 undefined）；
 * cli 分组内字段独立校验，非法字段仅丢弃该字段
 */
export function parseGcmpMetadata(text: string): GcmpMetadata | undefined {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return undefined;
    }
    const root = asRecord(raw);
    if (root.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
        return undefined;
    }
    const cli = asRecord(root.cli);
    const claudeCode = asRecord(cli.claudeCode);
    const codexTui = asRecord(cli.codexTui);
    return {
        schemaVersion: SUPPORTED_SCHEMA_VERSION,
        contentHash: asNonEmptyString(root.contentHash),
        cli: {
            claudeCodeVersion: asCliVersion(claudeCode.version),
            codexTuiVersion: asCliVersion(codexTui.version),
            codexTuiOriginator: asCliOriginator(codexTui.originator)
        }
    };
}

/** 当前生效的远程/本地 cli 元数据快照（由宿主层写入；undefined 表示无远程值） */
let remoteCliMetadata: GcmpCliMetadata | undefined;

/** 宿主层在加载/刷新成功后写入快照；传 undefined 清除（回退内置兜底） */
export function setRemoteCliMetadata(cli: GcmpCliMetadata | undefined): void {
    remoteCliMetadata = cli;
}

/** Claude Code CLI 仿真版本：远程快照优先，共享元数据文件内置兜底 */
export function getClaudeCodeCliVersion(): string {
    return remoteCliMetadata?.claudeCodeVersion ?? builtinMetadata.cli.claudeCode.version;
}

/** codex-tui 生效的 customHeader 基线：远程快照优先，共享元数据文件内置兜底 */
export function getCodexTuiCliHeader(): Record<string, string> {
    return {
        version: remoteCliMetadata?.codexTuiVersion ?? builtinMetadata.cli.codexTui.version,
        originator: remoteCliMetadata?.codexTuiOriginator ?? builtinMetadata.cli.codexTui.originator
    };
}

/**
 * 将 codex-tui 元数据合并进 codex 提供商配置（元数据 > 配置文件基线）
 * 必须在 applyProviderOverrides 之前调用，保证用户覆盖优先级最高（用户 > 远程 > 内置）
 */
export function withCodexCliMetadata(config: ProviderConfig): ProviderConfig {
    return { ...config, customHeader: { ...config.customHeader, ...getCodexTuiCliHeader() } };
}
