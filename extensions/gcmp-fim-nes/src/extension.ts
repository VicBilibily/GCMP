/*---------------------------------------------------------------------------------------------
 *  GCMP FIM/NES Completion - 扩展入口
 *
 *  从主扩展 GCMP (vicanent.gcmp) 拆分而来的行内补全扩展：
 *  - FIM (Fill In the Middle) 行内代码补全
 *  - NES (Next Edit Suggestions) 下一编辑建议
 *
 *  沿用主扩展的配置键（gcmp.fimCompletion.* / gcmp.nesCompletion.*）。
 *  运行时服务由主扩展白名单检测后主动注入（见 gcmpServices.ts 的注入协议）。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InlineCompletionShim } from './copilot/inlineCompletionShim';
import {
    acceptCompletionServices,
    assertMainExtensionCompatible,
    completionLogger as logger,
    notifyMainExtension
} from './gcmpServices';
import type { GcmpCompletionServices } from './types';
import { registerCompletionSchema } from './utils/completionSchema';

/** 主扩展注入入口的 exports 形状 */
interface GcmpFimNesExports {
    acceptCompletionServices(services: GcmpCompletionServices | null): void;
}

// This method is called when your extension is activated
export async function activate(context: vscode.ExtensionContext): Promise<GcmpFimNesExports> {
    let schema: ReturnType<typeof registerCompletionSchema> | undefined;

    try {
        assertMainExtensionCompatible();
        schema = registerCompletionSchema();
        const result = InlineCompletionShim.createAndActivate(context);
        context.subscriptions.push(result.provider, schema, logger);
        logger.info('[gcmp-fim-nes] Inline completion provider registered (shim mode)');
    } catch (error) {
        logger.error('[gcmp-fim-nes] Failed to register inline completion provider:', error);
        schema?.dispose();
        logger.dispose();
        throw error;
    }

    // 本扩展 exports 须发布之后主扩展才能回注，setImmediate 保证在 activate 返回后执行
    setImmediate(() => notifyMainExtension());

    return {
        acceptCompletionServices: services => {
            acceptCompletionServices(services);
            schema?.refresh();
        }
    };
}

// This method is called when your extension is deactivated
export function deactivate(): void {
    // 资源清理由 context.subscriptions 托管
}
