/*---------------------------------------------------------------------------------------------
 *  兼容提供商余额查询管理器
 *  管理所有兼容提供商的余额查询器
 *  作为全局静态实例提供，无需实例化
 *--------------------------------------------------------------------------------------------*/

import { StatusLogger } from '../../utils/statusLogger';
import { IBalanceQuery, BalanceQueryResult } from './balanceQuery';
import { AiHubMixBalanceQuery } from './providers/aihubmixBalanceQuery';
import { AiPingBalanceQuery } from './providers/aipingBalanceQuery';
import { SiliconflowBalanceQuery } from './providers/siliconflowBalanceQuery';

/**
 * 余额查询管理器
 * 负责管理所有兼容提供商的余额查询器
 * 作为全局静态实例提供，所有方法均为静态方法
 */
export class BalanceQueryManager {
    private static queryHandlers = new Map<string, IBalanceQuery>();
    private static initialized = false;

    /** 私有构造函数，禁止实例化 */
    private constructor() {}

    /**
     * 初始化管理器（注册默认处理器）
     * 首次调用任何静态方法时自动初始化
     */
    private static ensureInitialized(): void {
        if (!BalanceQueryManager.initialized) {
            BalanceQueryManager.registerDefaultHandlers();
            BalanceQueryManager.initialized = true;
        }
    }

    /**
     * 注册默认的余额查询器
     */
    private static registerDefaultHandlers(): void {
        BalanceQueryManager.registerHandler('aihubmix', new AiHubMixBalanceQuery());
        BalanceQueryManager.registerHandler('aiping', new AiPingBalanceQuery());
        BalanceQueryManager.registerHandler('siliconflow', new SiliconflowBalanceQuery());
    }

    /**
     * 注册余额查询器
     * @param providerId 提供商标识符
     * @param handler 余额查询器实例
     */
    static registerHandler(providerId: string, handler: IBalanceQuery): void {
        BalanceQueryManager.queryHandlers.set(providerId, handler);
        StatusLogger.debug(`[BalanceQueryManager] 已注册提供商 ${providerId} 的余额查询器`);
    }

    /**
     * 注销余额查询器
     * @param providerId 提供商标识符
     */
    static unregisterHandler(providerId: string): void {
        if (BalanceQueryManager.queryHandlers.has(providerId)) {
            BalanceQueryManager.queryHandlers.delete(providerId);
            StatusLogger.debug(`[BalanceQueryManager] 已注销提供商 ${providerId} 的余额查询器`);
        }
    }

    /**
     * 查询提供商余额
     * @param providerId 提供商标识符
     * @returns 余额查询结果
     */
    static async queryBalance(providerId: string): Promise<BalanceQueryResult> {
        BalanceQueryManager.ensureInitialized();

        const handler = BalanceQueryManager.queryHandlers.get(providerId);

        if (!handler) {
            // 如果没有注册的查询器，返回默认值
            StatusLogger.warn(`[BalanceQueryManager] 未找到提供商 ${providerId} 的余额查询器，使用默认值`);
            return {
                balance: 0,
                currency: 'CNY'
            };
        }

        try {
            const result = await handler.queryBalance(providerId);
            StatusLogger.debug(`[BalanceQueryManager] 成功查询提供商 ${providerId} 的余额: ${result.balance}`);
            return result;
        } catch (error) {
            StatusLogger.error(`[BalanceQueryManager] 查询提供商 ${providerId} 余额失败`, error);
            // 查询失败时抛出错误，让上层处理
            throw error;
        }
    }

    /**
     * 获取所有已注册的提供商ID
     * @returns 提供商ID列表
     */
    static getRegisteredProviders(): string[] {
        BalanceQueryManager.ensureInitialized();
        return Array.from(BalanceQueryManager.queryHandlers.keys());
    }

    /**
     * 检查是否已注册指定提供商的查询器
     * @param providerId 提供商标识符
     * @returns 是否已注册
     */
    static hasHandler(providerId: string): boolean {
        BalanceQueryManager.ensureInitialized();
        return BalanceQueryManager.queryHandlers.has(providerId);
    }
}
