/*---------------------------------------------------------------------------------------------
 *  Codex 风格 User-Agent 生成
 *  对齐 openai/codex 中 get_codex_user_agent()：
 *  {originator}/{version} ({os_type} {os_version}; {arch}) {terminal_token} ({suffix})
 *  纯 Node 逻辑（无 vscode 依赖），可供 codexProvider 及 openai sdkMode 按需使用
 *
 *  平台近似：Windows 的 os_type/os_version 对齐 os_info（NT 内核版本）；
 *  macOS/Linux 使用 Node 的 Darwin/内核版本，不是 os_info 的发行版号
 *--------------------------------------------------------------------------------------------*/

import * as os from 'os';
import { ensureUserAgentHeader, getUserAgentHeaderValue } from './httpHeaders';

/**
 * 生成 User-Agent 所需的字段
 * 与 codex CLI 的格式对应：{originator}/{version} ({os_type} {os_version}; {arch}) {terminal_token} ({suffix})
 */
export interface CodexUserAgentOptions {
    /** originator 标识（如 codex-tui / codex_vscode / codex_cli_rs），默认 codex-tui */
    originator?: string;
    /** codex CLI 版本号（如 0.153.0） */
    version?: string;
    /** 操作系统类型（缺省自动探测，如 Windows / Mac OS / Linux） */
    osType?: string;
    /** 操作系统版本（缺省取 os.release()，Windows 为 NT 内核版本如 10.0.26200） */
    osVersion?: string;
    /** CPU 架构（缺省按 process.arch 映射，如 x86_64 / arm64） */
    architecture?: string;
    /** 终端标识 token（当前不传递，缺省 unknown） */
    terminalToken?: string;
    /** 附加到 UA 末尾的括号后缀（如 "codex-tui; 0.153.0"），缺省不带 */
    suffix?: string;
}

/** codex TUI 客户端的默认 originator */
const DEFAULT_ORIGINATOR = 'codex-tui';

/**
 * 净化 User-Agent 字符串
 * 对齐 codex CLI 的 sanitize_user_agent()：非可见 ASCII 字符替换为下划线
 */
function sanitizeUserAgent(candidate: string): string {
    return candidate.replace(/[^ -~]/g, '_');
}

/** 将 process.platform 映射为 os_info 风格的操作系统类型 */
function detectOsType(): string {
    switch (process.platform) {
        case 'win32':
            return 'Windows';
        case 'darwin':
            return 'Mac OS';
        case 'linux':
            return 'Linux';
        default:
            return process.platform;
    }
}

/** 将 process.arch 映射为 os_info 风格的 CPU 架构 */
function detectArchitecture(): string {
    switch (process.arch) {
        case 'x64':
            return 'x86_64';
        case 'ia32':
            return 'i686';
        default:
            return process.arch;
    }
}

/**
 * 按给定字段组装 Codex 风格 User-Agent（纯函数，可单测）
 */
export function buildCodexUserAgent(options: CodexUserAgentOptions): string {
    const originator = options.originator || DEFAULT_ORIGINATOR;
    const version = options.version || '';
    const osType = options.osType || '';
    const osVersion = options.osVersion || '';
    const architecture = options.architecture || 'unknown';
    const terminalToken = options.terminalToken || 'unknown';

    let ua = `${originator}/${version} (${osType} ${osVersion}; ${architecture}) ${terminalToken}`;
    if (options.suffix && options.suffix.trim()) {
        ua += ` (${options.suffix.trim()})`;
    }
    return sanitizeUserAgent(ua);
}

/**
 * 生成 Codex 风格 User-Agent
 * 未显式指定的系统字段（操作系统/架构/终端）按当前运行环境自动探测
 */
export function getCodexUserAgent(options: CodexUserAgentOptions = {}): string {
    return buildCodexUserAgent({
        originator: options.originator,
        version: options.version,
        osType: options.osType ?? detectOsType(),
        osVersion: options.osVersion ?? os.release(),
        architecture: options.architecture ?? detectArchitecture(),
        terminalToken: options.terminalToken ?? 'unknown',
        suffix: options.suffix
    });
}

/**
 * 生成 codex-tui 客户端形态的 User-Agent
 * 与 codex CLI TUI 一致：originator 与后缀都携带客户端标识与版本
 */
export function getCodexTuiUserAgent(version: string, originator = DEFAULT_ORIGINATOR): string {
    return getCodexUserAgent({
        originator,
        version,
        suffix: version ? `${originator}; ${version}` : undefined
    });
}

/** 从 customHeader 的 originator/version 生成 TUI 形态 UA（缺省回退打包默认值） */
export function getCodexTuiUserAgentFromHeader(header?: Record<string, string>): string {
    return getCodexTuiUserAgent(header?.version ?? '', header?.originator);
}

/**
 * compatible 等场景：模型 id/model 含 gpt、非 anthropic、且用户未指定 User-Agent 时，补全 Codex 请求头
 */
export function fillCodexRequestHeaders(
    model: { id: string; model?: string; sdkMode?: string; customHeader?: Record<string, string> },
    defaults?: Record<string, string>
): Record<string, string> | undefined {
    const customHeader = model.customHeader;
    if (model.sdkMode === 'anthropic') {
        return customHeader;
    }
    if (!`${model.id} ${model.model ?? ''}`.toLowerCase().includes('gpt')) {
        return customHeader;
    }
    if (getUserAgentHeaderValue(customHeader)?.trim()) {
        return customHeader;
    }
    const merged = { ...defaults, ...customHeader };
    return ensureUserAgentHeader(merged, getCodexTuiUserAgentFromHeader(merged));
}
