/*---------------------------------------------------------------------------------------------
 *  Copilot Log Target - 日志目标实现
 *  实现 ILogTarget 接口
 *  参考: getInlineCompletions.spec.ts 中的 NullLogTarget
 *  参考: nesProvider.spec.ts 中的 TestLogTarget
 *--------------------------------------------------------------------------------------------*/

import { ILogTarget, LogLevel } from '@vscode/chat-lib';
import { NESLogger } from '../utils/nesLogger';

/**
 * 日志目标实现
 */
export class CopilotLogTarget implements ILogTarget {
    logIt(level: LogLevel, metadataStr: string, ...extra: unknown[]): void {
        switch (level) {
            case LogLevel.Error:
                NESLogger.error(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Warning:
                NESLogger.warn(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Info:
                NESLogger.info(`[CopilotLogTarget] ${metadataStr}`, ...extra);
                return;
            // case LogLevel.Debug:
            //     NESLogger.debug(`[CopilotLogTarget] ${metadataStr}`, ...extra);
            //     return;
            // case LogLevel.Trace:
            //     NESLogger.trace(`[CopilotLogTarget] ${metadataStr}`, ...extra);
            //     return;
        }
    }
}
