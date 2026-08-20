/*---------------------------------------------------------------------------------------------
 * CLI 凭证刷新跨窗口竞态：写前双检复用另一窗口刚落盘的新 token，force 刷新不受影响
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ConfigManager 必须先于 CLI auth 模块求值：bundle 内存在
// baseCliAuth → ConfigManager → … → cliAuthFactory → codexCliAuth → baseCliAuth 的环，
// 先求值 ConfigManager 可让环在 baseCliAuth 处安全断开（其仅在方法内使用 ConfigManager）
import { ConfigManager } from '../../src/utils/config/configManager';
import { BaseCliAuth } from '../../src/cli/auth/baseCliAuth';
import { CodexCliAuth } from '../../src/cli/auth/codexCliAuth';

function makeTempCredentialFile(): string {
    return path.join(os.tmpdir(), `gcmp-cli-auth-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function writeExpiredCredentials(filePath: string): void {
    fs.writeFileSync(
        filePath,
        JSON.stringify({
            access_token: 'at-initial',
            refresh_token: 'rt-initial',
            expiry_date: Date.now() - 60_000
        }),
        'utf-8'
    );
}

suite('CLI auth refresh coordination', () => {
    test('concurrent windows share one refresh via pre-refresh double check', async () => {
        const credentialPath = makeTempCredentialFile();
        writeExpiredCredentials(credentialPath);

        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let refreshCalls = 0;
        let issuedTokenSeq = 0;

        try {
            BaseCliAuth.setCredentialPathOverride(credentialPath);
            ConfigManager.fetchWithProxy = (async () => {
                refreshCalls += 1;
                issuedTokenSeq += 1;
                const payload = JSON.stringify({
                    access_token: `at-refreshed-${issuedTokenSeq}`,
                    refresh_token: `rt-refreshed-${issuedTokenSeq}`,
                    expires_in: 3600
                });
                return {
                    ok: true,
                    status: 200,
                    text: async () => payload
                } as never;
            }) as typeof ConfigManager.fetchWithProxy;

            // 模拟两个 VS Code 窗口：独立实例各自持有缓存与单飞 promise，共享同一凭证文件
            const windowA = new CodexCliAuth();
            const windowB = new CodexCliAuth();

            const expiredA = await windowA.loadCredentials();
            const expiredB = await windowB.loadCredentials();
            assert.equal(expiredA?.refresh_token, 'rt-initial');
            assert.equal(expiredB?.refresh_token, 'rt-initial');

            // 窗口 A 先刷新：发起一次网络请求并把新凭证落盘
            const refreshedA = await windowA.refreshCredentials(expiredA);
            assert.equal(refreshedA.access_token, 'at-refreshed-1');
            assert.equal(refreshCalls, 1);

            // 窗口 B 持有过期快照发起刷新：写前双检发现文件已是新 token，不再 POST
            const refreshedB = await windowB.refreshCredentials(expiredB);
            assert.equal(refreshedB.access_token, 'at-refreshed-1');
            assert.equal(refreshCalls, 1);
        } finally {
            BaseCliAuth.setCredentialPathOverride(undefined);
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            try {
                fs.rmSync(credentialPath, { force: true });
            } catch {
                // ignore
            }
        }
    });

    test('force refresh bypasses the double check and issues a network refresh', async () => {
        const credentialPath = makeTempCredentialFile();
        writeExpiredCredentials(credentialPath);

        const originalFetchWithProxy = ConfigManager.fetchWithProxy;
        let refreshCalls = 0;
        let issuedTokenSeq = 0;

        try {
            BaseCliAuth.setCredentialPathOverride(credentialPath);
            ConfigManager.fetchWithProxy = (async () => {
                refreshCalls += 1;
                issuedTokenSeq += 1;
                const payload = JSON.stringify({
                    access_token: `at-refreshed-${issuedTokenSeq}`,
                    refresh_token: `rt-refreshed-${issuedTokenSeq}`,
                    expires_in: 3600
                });
                return {
                    ok: true,
                    status: 200,
                    text: async () => payload
                } as never;
            }) as typeof ConfigManager.fetchWithProxy;

            const window = new CodexCliAuth();

            const first = await window.refreshCredentials();
            assert.equal(first.access_token, 'at-refreshed-1');
            assert.equal(refreshCalls, 1);

            // token 未过期，但 force 刷新（面板手动刷新）必须仍走网络
            const forced = await window.refreshCredentials(undefined, true);
            assert.equal(forced.access_token, 'at-refreshed-2');
            assert.equal(refreshCalls, 2);
        } finally {
            BaseCliAuth.setCredentialPathOverride(undefined);
            ConfigManager.fetchWithProxy = originalFetchWithProxy;
            try {
                fs.rmSync(credentialPath, { force: true });
            } catch {
                // ignore
            }
        }
    });
});
