/*---------------------------------------------------------------------------------------------
 *  Copilot Log Target - 日志目标实现
 *  实现 ILogTarget 接口
 *  参考: getInlineCompletions.spec.ts 中的 NullLogTarget
 *  参考: nesProvider.spec.ts 中的 TestLogTarget
 *--------------------------------------------------------------------------------------------*/

import { ILogTarget, LogLevel } from '@vscode/chat-lib';
import { getCompletionLogger } from './singletons';

/**
 * 日志目标实现
 */
export class CopilotLogTarget implements ILogTarget {
    logIt(level: LogLevel, metadataStr: string, ...extra: unknown[]): void {
        const CompletionLogger = getCompletionLogger();
        switch (level) {
            case LogLevel.Error:
                CompletionLogger.error(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Warning:
                CompletionLogger.warn(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Info:
                // CompletionLogger.info(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                // return;
                // case LogLevel.Debug:
                CompletionLogger.debug(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            // case LogLevel.Trace:
            //     CompletionLogger.trace(`[CopilotLogTarget] ${metadataStr}`, ...extra);
            //     return;
        }
    }
}
