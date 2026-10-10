import * as vscode from 'vscode';
import type { ApiKeyManagerLike, ConfigManagerLike, GcmpCompletionServices } from './types';

// 补全日志通道由本扩展自建（completionLogger.ts），随共享 bundle 提供给双 bundle 使用
export { completionLogger } from './completionLogger';

/** GCMP 主扩展标识 */
export const GCMP_EXTENSION_ID = 'vicanent.gcmp';
/** 本扩展标识（主扩展注入白名单校验用） */
export const GCMP_FIM_NES_ID = 'vicanent.gcmp-fim-nes';

/** 主扩展 exports 的形状 */
interface GcmpMainExports {
    notifyConsumerReady?(consumerId: string): void;
    verifyCompletionServices?(candidate: object): boolean;
}

// ========================================================================
// 注入接收
// ========================================================================

/** 已注入的服务（主扩展主动注入并经引用验证通过） */
let injectedServices: GcmpCompletionServices | null = null;

/** 注入被拒绝的上报只记一次 */
let injectionRejectionReported = false;

/** 主扩展不可用提示只上报一次 */
let unavailabilityReported = false;

function reportUnavailable(detail: string): void {
    if (unavailabilityReported) {
        return;
    }
    unavailabilityReported = true;
    console.error(`[gcmp-fim-nes] GCMP main extension services unavailable: ${detail}`);
}

function isCompleteServices(services: GcmpCompletionServices | undefined | null): services is GcmpCompletionServices {
    return (
        typeof services?.ApiKeyManager?.getApiKey === 'function' &&
        typeof services?.ConfigManager?.fetchWithProxy === 'function' &&
        typeof services?.closeProxyAgents === 'function' &&
        typeof services?.getAvailableProviders === 'function'
    );
}

export function assertMainExtensionCompatible(): void {
    const main = vscode.extensions.getExtension<GcmpMainExports>(GCMP_EXTENSION_ID);
    if (
        !main?.isActive ||
        typeof main.exports?.notifyConsumerReady !== 'function' ||
        typeof main.exports?.verifyCompletionServices !== 'function'
    ) {
        throw new Error(
            'GCMP main extension must support the FIM/NES services bridge. Update or enable GCMP and reload the window.'
        );
    }
}

/**
 * 注入入口（由主扩展调用，亦见本扩展 activate 返回的 exports）
 *
 * 安全闭环：注入对象必须能通过真实主扩展 exports 的引用比对（verifyCompletionServices）
 * 才被接受，伪造服务无法通过——第三方扩展拿不到主扩展创建的服务对象引用。
 */
export function acceptCompletionServices(services: GcmpCompletionServices | null): void {
    if (!isCompleteServices(services)) {
        console.warn('[gcmp-fim-nes] Rejected completion services injection: incomplete services');
        return;
    }

    // 注入来源校验：只有真实主扩展会确认它注入的服务对象引用
    const main = vscode.extensions.getExtension<GcmpMainExports>(GCMP_EXTENSION_ID);
    const verified = !!main?.isActive && main.exports?.verifyCompletionServices?.(services) === true;
    if (!verified) {
        if (!injectionRejectionReported) {
            injectionRejectionReported = true;
            console.warn('[gcmp-fim-nes] Rejected completion services injection: verification failed');
        }
        return;
    }

    injectedServices = services;
    console.info('[gcmp-fim-nes] Completion services accepted from GCMP main extension');
}

/**
 * 通知主扩展本扩展已就绪（须在 activate 返回、exports 发布之后调用，否则主扩展回注会落空）
 */
export function notifyMainExtension(): void {
    try {
        const main = vscode.extensions.getExtension<GcmpMainExports>(GCMP_EXTENSION_ID);
        if (!main?.isActive) {
            reportUnavailable('GCMP main extension is not active');
            return;
        }
        main.exports?.notifyConsumerReady?.(GCMP_FIM_NES_ID);
    } catch (error) {
        reportUnavailable(error instanceof Error ? error.message : String(error));
    }
}

// ========================================================================
// 服务解析
// ========================================================================

/** 主扩展服务是否可用（不可用时 FIM/NES 不加载真实补全引擎） */
export function isGcmpServicesAvailable(): boolean {
    return injectedServices !== null;
}

// ========================================================================
// 服务不可用时的降级 stub
// ========================================================================

function unavailableError(): Error {
    return new Error('GCMP main extension (vicanent.gcmp) is required for FIM/NES completion');
}

// ========================================================================
// 单例访问器（保持与原 src/copilot/singletons.ts 相同的调用形状）
// ========================================================================

/** 获取共享的 ApiKeyManager（不可用时抛错，由调用方捕获记录） */
export function getApiKeyManager(): ApiKeyManagerLike {
    const services = injectedServices;
    if (!services) {
        throw unavailableError();
    }
    return services.ApiKeyManager;
}

/** 获取共享的 ConfigManager（不可用时抛错，由调用方捕获记录） */
export function getConfigManager(): ConfigManagerLike {
    const services = injectedServices;
    if (!services) {
        throw unavailableError();
    }
    return services.ConfigManager;
}

export function getAvailableProviders(): ReturnType<GcmpCompletionServices['getAvailableProviders']> {
    return injectedServices?.getAvailableProviders() ?? { providerIds: [], enumDescriptions: [] };
}

/** 关闭主扩展共享的 ProxyAgent 连接池（不可用时为 no-op） */
export async function closeProxyAgents(): Promise<void> {
    await injectedServices?.closeProxyAgents();
}
