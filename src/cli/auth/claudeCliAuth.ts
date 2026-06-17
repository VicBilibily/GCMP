/*---------------------------------------------------------------------------------------------
 *  Claude Code CLI 认证实现
 *  检测 claude CLI 是否已安装并已通过 OAuth 登录
 *  使用 spawn（兼容 .cmd 批处理文件）替代 execSync（Windows PATH 问题）
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'child_process';
import { BaseCliAuth } from './baseCliAuth';
import { Logger } from '../../utils/logger';
import type { CliAuthConfig, OAuthCredentials } from '../type';

/**
 * Claude Code CLI 认证类
 * 仅检测 CLI 是否存在且已验证，不管理 OAuth token。
 * Claude CLI 自己处理凭证，GCMP 只需要确保 claude 命令可用。
 */
export class ClaudeCliAuth extends BaseCliAuth {
    constructor() {
        const config: CliAuthConfig = {
            providerKey: 'claude',
            name: 'Claude Code CLI',
            clientId: '',
            tokenUrl: '',
            credentialPathPattern: '',
            cliCommand: 'claude'
        };
        super(config);
    }

    /**
     * 检查 claude CLI 是否已安装且可用
     * 使用 spawnSync + shell:true 确保 Windows 上 .cmd 文件能被正确找到
     */
    override async isCliInstalled(): Promise<boolean> {
        try {
            const result = spawnSync('claude', ['--version'], {
                encoding: 'utf-8',
                stdio: 'pipe',
                shell: true,
                windowsHide: true,
                timeout: 5000
            });
            if (result.status === 0 && result.stdout) {
                Logger.info(`[ClaudeCodeCLI] Detected: ${result.stdout.trim()}`);
                return true;
            }
            Logger.debug(`[ClaudeCodeCLI] Not detected (exit=${result.status})`);
            return false;
        } catch (err) {
            Logger.debug(`[ClaudeCodeCLI] Not detected: ${err instanceof Error ? err.message : 'unknown error'}`);
            return false;
        }
    }

    /**
     * 检查 Claude CLI 是否已登录
     */
    async isLoggedIn(): Promise<boolean> {
        try {
            const result = spawnSync('claude', ['auth', 'status'], {
                stdio: 'ignore',
                shell: true,
                windowsHide: true,
                timeout: 10000
            });
            return result.status === 0;
        } catch {
            return false;
        }
    }

    /**
     * 获取 Claude CLI 版本
     */
    async getVersion(): Promise<string | null> {
        try {
            const result = spawnSync('claude', ['--version'], {
                encoding: 'utf-8',
                stdio: 'pipe',
                shell: true,
                windowsHide: true,
                timeout: 5000
            });
            return result.status === 0 ? result.stdout.trim() : null;
        } catch {
            return null;
        }
    }

    /**
     * Claude CLI 没有独立的凭证文件可读取（Keychain 管理）
     */
    override async loadCredentials(): Promise<OAuthCredentials | null> {
        const loggedIn = await this.isLoggedIn();
        if (!loggedIn) {
            return null;
        }
        // 返回一个虚拟凭证，表示"已认证"
        return {
            access_token: 'claude-cli-authenticated',
            refresh_token: '',
            expiry_date: Date.now() + 24 * 60 * 60 * 1000
        };
    }
}
