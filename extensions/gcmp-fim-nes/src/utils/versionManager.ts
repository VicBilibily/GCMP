/*---------------------------------------------------------------------------------------------
 *  版本管理工具
 *  跨扩展查询 GCMP 主扩展的版本号（编辑器插件信息、User-Agent 均沿用主扩展身份）
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 版本管理器
 */
export class VersionManager {
    private static _version: string | null = null;

    /**
     * 获取 GCMP 主扩展版本号
     */
    static getVersion(): string {
        if (this._version === null) {
            const extension = vscode.extensions.getExtension('vicanent.gcmp');
            this._version = extension?.packageJSON?.version || '0.4.0';
        }
        return this._version!;
    }

    /**
     * 获取用户代理字符串
     */
    static getUserAgent(component: string): string {
        return `GCMP-${component}/${this.getVersion()}`;
    }

    /**
     * 获取客户端信息
     */
    static getClientInfo(): { name: string; version: string } {
        return {
            name: 'GCMP',
            version: this.getVersion()
        };
    }

    /**
     * 重置缓存（主要用于测试）
     */
    static resetCache(): void {
        this._version = null;
    }
}
