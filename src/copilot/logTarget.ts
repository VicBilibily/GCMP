/*---------------------------------------------------------------------------------------------
 *  Copilot Log Target - 日志目标实现
 *  实现 ILogTarget 接口
 *  参考: getInlineCompletions.spec.ts 中的 NullLogTarget
 *--------------------------------------------------------------------------------------------*/

import { ILogTarget, LogLevel } from '@vscode/chat-lib';
import { Logger } from '../utils/logger';

/**
 * 日志目标实现
 */
export class LogTarget implements ILogTarget {
    logIt(level: LogLevel, metadataStr: string, ...extra: unknown[]): void {
        switch (level) {
            case LogLevel.Error:
                Logger.error(`[LogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Warning:
                Logger.warn(`[LogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Info:
                Logger.info(`[LogTarget] ${metadataStr}`, ...extra);
                return;
            case LogLevel.Debug:
                Logger.debug(`[LogTarget] ${metadataStr}`, ...extra);
                return;
        }
    }
}
