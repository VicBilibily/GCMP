/*---------------------------------------------------------------------------------------------
 *  Copilot CAPI Client - CAPI 客户端服务实现
 *  实现 ICAPIClientService 接口（自定义空实现）
 *  自定义空实现，不依赖 @vscode/copilot-api 的 CAPIClient
 *--------------------------------------------------------------------------------------------*/

/**
 * CAPIClientService 空实现
 * ICAPIClientService 接口要求继承 CAPIClient，但我们使用类型断言绕过
 */
export class CAPIClientService {
    readonly _serviceBrand: undefined;

    // CAPIClient 基本属性
    // proxyBaseURL 必须是有效 URL，chat-lib 内部会用它构建请求地址
    readonly domain = 'https://github-copilot.localhost';
    readonly copilotTelemetryURL = this.domain;
    readonly dotcomAPIURL = this.domain;
    readonly capiPingURL = this.domain;
    readonly proxyBaseURL = this.domain;
    readonly originTrackerURL = this.domain;
    readonly snippyMatchPath = '/v1/completions';
    readonly snippyFilesForMatchPath = '/v1/completions';

    // CAPIClient 方法（空实现）
    updateDomains() {
        return {
            capiUrlChanged: false,
            telemetryUrlChanged: false,
            dotcomUrlChanged: false,
            proxyUrlChanged: false
        };
    }

    async makeRequest(): Promise<never> {
        throw new Error('CAPIClientService.makeRequest not implemented - GCMP uses custom fetcher');
    }
}
