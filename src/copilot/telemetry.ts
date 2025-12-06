/*---------------------------------------------------------------------------------------------
 *  Copilot Telemetry - 遥测服务实现
 *  实现 ITelemetrySender 接口
 *  参考: getInlineCompletions.spec.ts 中的 TestTelemetrySender
 *--------------------------------------------------------------------------------------------*/

import { ITelemetrySender } from '@vscode/chat-lib';

/**
 * 遥测发送器实现
 */
export class TelemetrySender implements ITelemetrySender {
    sendTelemetryEvent(
        _eventName: string,
        _properties?: Record<string, string | undefined>,
        _measurements?: Record<string, number | undefined>
    ): void {
        return;
    }
}
