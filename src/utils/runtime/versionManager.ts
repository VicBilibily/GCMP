/*---------------------------------------------------------------------------------------------
 *  版本管理工具
 *  提供统一的版本号获取方法
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * 版本管理器
 */
export class VersionManager {
    private static _version: string | null = null;

    /**
     * 获取扩展版本号
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
