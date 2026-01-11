/*---------------------------------------------------------------------------------------------
 *  CLI 认证工厂
 *  管理不同 CLI 提供商的认证实例
 *--------------------------------------------------------------------------------------------*/

import { BaseCliAuth } from './baseCliAuth';
import { IFlowCliAuth } from './iflowCliAuth';
import { GeminiCliAuth } from './geminiCliAuth';
import { QwenCodeCliAuth } from './qwenCodeCliAuth';
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
            case 'iflow':
                instance = new IFlowCliAuth();
                break;
            case 'qwen':
                instance = new QwenCodeCliAuth();
                break;
            case 'gemini':
                instance = new GeminiCliAuth();
                break;
            default:
                Logger.warn(`[CliAuthFactory] 未知的 CLI 类型: ${cliType}`);
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
     * 获取支持的 CLI 类型列表
     */
    static getSupportedCliTypes(): Array<{ id: string; name: string }> {
        return [
            { id: 'iflow', name: 'iFlow CLI' },
            { id: 'qwen', name: 'Qwen Code CLI' },
            { id: 'gemini', name: 'Gemini CLI' }
        ];
    }
}
