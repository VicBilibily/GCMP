/*---------------------------------------------------------------------------------------------
 *  CLI 认证工厂
 *  管理不同 CLI 提供商的认证实例
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { CodexCliAuth } from './codexCliAuth';
import { GrokCliAuth } from './grokCliAuth';
import { Logger } from '../../utils/logger';
import { OAuthCredentials } from '../type';

/**
 * CLI 认证工厂
 * 单例模式，管理所有 CLI 提供商的认证实例
 */
export class CliAuthFactory {
    private static instances = new Map<string, BaseCliAuth>();

    /**
     * 获取指定 CLI 类型的认证实例
     */
    static getInstance(cliType: string): BaseCliAuth | null {
        // 如果已存在实例，直接返回
        if (this.instances.has(cliType)) {
            return this.instances.get(cliType)!;
        }
        // 创建新实例
        let instance: BaseCliAuth | null = null;
        switch (cliType) {
            case 'codex':
                instance = new CodexCliAuth();
                break;
            case 'grok':
                instance = new GrokCliAuth();
                break;
            default:
                Logger.warn(`[CliAuthFactory] Unknown CLI type: ${cliType}`);
                return null;
        }
        if (instance) {
            this.instances.set(cliType, instance);
        }
        return instance;
    }

    /**
     * 加载 CLI OAuth 凭证
     */
    static async loadCredentials(cliType: string): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }
        return await instance.loadCredentials();
    }

    /**
     * 确保认证有效（自动刷新过期令牌）
     */
    static async ensureAuthenticated(cliType: string): Promise<OAuthCredentials | null> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return null;
        }
        return await instance.ensureAuthenticated();
    }

    /**
     * 判断凭证是否已过期（只读，不触发网络刷新）
     * 由各 CLI 子类的 getExpiryBufferMs() 决定具体缓冲时间
     */
    static isCredentialExpired(cliType: string, credentials: OAuthCredentials): boolean {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return true;
        }
        return instance.isExpired(credentials);
    }

    /**
     * 检查 CLI 是否已安装
     */
    static async isCliInstalled(cliType: string): Promise<boolean> {
        const instance = this.getInstance(cliType);
        if (!instance) {
            return false;
        }
        return await instance.isCliInstalled();
    }

    /**
     * 获取凭证文件路径
     */
    static getCredentialPath(cliType: string): string | null {
        const instance = this.getInstance(cliType);
        return instance ? instance.getCredentialPath() : null;
    }

    /**
     * 获取 CLI 进程环境变量（包含 provider 级代理）
     */
    static getProcessEnv(cliType: string): NodeJS.ProcessEnv {
        const instance = this.getInstance(cliType);
        return instance ? instance.getCliProcessEnv() : { ...process.env };
    }

    /** 获取 Codex 请求所需的 ChatGPT 账户 ID */
    static async getCodexAccountId(): Promise<string | null> {
        const instance = this.getInstance('codex');
        return instance instanceof CodexCliAuth ? instance.getAccountId() : null;
    }

    /**
     * 获取支持的 CLI 类型列表
     */
    static getSupportedCliTypes(): Array<{ id: string; name: string }> {
        return [
            { id: 'codex', name: 'Codex CLI' },
            { id: 'grok', name: 'Grok Build' }
        ];
    }
}
