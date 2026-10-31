import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

interface Credentials {
    access_token: string;
    refresh_token: string;
    expiry_date: number;
}

interface BusEvent {
    type: string;
    payload: Record<string, unknown>;
    senderInstanceId?: string;
}

test('原生凭证过期时由 Leader 按原生路径刷新并回读', async () => {
    const nativePath = 'C:/cli/codex/auth.json';
    const pathCalls: string[] = [];
    const handlers = new Map<string, (event: BusEvent) => void>();
    const contextModule: { exports: Record<string, unknown> } = { exports: {} };
    let credentials: Credentials = {
        access_token: 'expired-token',
        refresh_token: 'native-refresh-token',
        expiry_date: Date.now() - 1_000
    };
    let leaderCanHandle = false;
    let leaderId = 'leader';
    let failNextLeaderRefresh = false;
    let failoverAfterFailure = false;
    let dropNextLeaderRefresh = false;
    let requestedSource: unknown;
    let requestedForceRefresh: unknown;

    class FakeBaseCliAuth {
        getCliNativeCredentialPath(): string {
            return nativePath;
        }

        async loadCredentialsFromPath(filePath: string): Promise<Credentials> {
            pathCalls.push(`load:${filePath}`);
            return credentials;
        }

        isExpired(value: Credentials): boolean {
            return value.expiry_date <= Date.now();
        }

        invalidateCredentialCache(): void {}

        async ensureAuthenticatedFromPath(filePath: string, _forceRefresh: boolean): Promise<Credentials> {
            pathCalls.push(`refresh:${filePath}`);
            if (leaderCanHandle && failNextLeaderRefresh) {
                failNextLeaderRefresh = false;
                throw new Error('leader refresh failed');
            }
            credentials = { ...credentials, access_token: 'refreshed-token', expiry_date: Date.now() + 60_000 };
            return credentials;
        }

        async ensureAuthenticated(_forceRefresh: boolean): Promise<Credentials> {
            pathCalls.push('active:oauth');
            return {
                access_token: 'active-oauth-token',
                refresh_token: 'active-oauth-refresh-token',
                expiry_date: Date.now() + 60_000
            };
        }
    }

    class FakeCodexCliAuth extends FakeBaseCliAuth {}
    class FakeGrokCliAuth extends FakeBaseCliAuth {}

    const interInstanceBus = {
        subscribe: (type: string, handler: (event: BusEvent) => void) => {
            handlers.set(type, handler);
            return { dispose: () => undefined };
        },
        publish: (event: BusEvent) => {
            if (event.type === 'cliAuthRefreshRequested') {
                requestedSource = event.payload.credentialSource;
                requestedForceRefresh = event.payload.forceRefresh;
                if (dropNextLeaderRefresh) {
                    dropNextLeaderRefresh = false;
                    return;
                }
                queueMicrotask(() => {
                    leaderCanHandle = true;
                    handlers.get(event.type)?.({ ...event, senderInstanceId: 'follower' });
                    leaderCanHandle = false;
                });
                return;
            }
            if (event.type === 'cliAuthRefreshCompleted') {
                if (event.payload.success === false && failoverAfterFailure) {
                    leaderId = 'follower';
                }
                handlers.get(event.type)?.({ ...event, senderInstanceId: 'leader' });
            }
        }
    };

    const dependencies: Record<string, unknown> = {
        path,
        vscode: {},
        './baseCliAuth': { BaseCliAuth: FakeBaseCliAuth },
        './codexCliAuth': { CodexCliAuth: FakeCodexCliAuth },
        './grokCliAuth': { GrokCliAuth: FakeGrokCliAuth },
        '../../utils/runtime/logger': { Logger: { info() {}, warn() {}, error() {}, trace() {} } },
        '../type': {},
        './oauthCredentialStore': {
            OAuthCredentialStore: {
                initialize() {},
                getCredentialPath() {
                    return undefined;
                }
            }
        },
        '../../interInstance': { InterInstanceBus: interInstanceBus },
        '../../status': {
            LeaderElectionService: {
                getLeaderId: () => leaderId,
                getInstanceId: () => 'follower',
                isLeader: () => leaderCanHandle,
                isLeaderHeartbeatFresh: () => true
            }
        }
    };
    const source = readFileSync(new URL('./cliAuthFactory.ts', import.meta.url), 'utf8');
    runInNewContext(
        transformSync(source, { loader: 'ts', format: 'cjs', target: 'es2022' }).code,
        {
            module: contextModule,
            exports: contextModule.exports,
            setTimeout,
            clearTimeout,
            require: (id: string): unknown => {
                if (Object.hasOwn(dependencies, id)) {
                    return dependencies[id];
                }
                throw new Error(`Unexpected dependency: ${id}`);
            }
        },
        { filename: 'cliAuthFactory.ts', timeout: 1000 }
    );

    const factory = contextModule.exports.CliAuthFactory as {
        initialize: (context: unknown) => void;
        CLI_AUTH_REFRESH_TIMEOUT_MS: number;
        ensureCliNativeAuthenticated: (provider: string, forceRefresh?: boolean) => Promise<Credentials | null>;
    };
    factory.initialize({ globalStorageUri: { fsPath: 'C:/extension/storage' }, subscriptions: [] });
    const refreshed = await factory.ensureCliNativeAuthenticated('codex');

    assert.equal(requestedSource, 'cliNative');
    assert.equal(refreshed?.access_token, 'refreshed-token');
    assert.deepEqual(pathCalls, [`load:${nativePath}`, `refresh:${nativePath}`, `load:${nativePath}`]);

    pathCalls.length = 0;
    credentials = {
        access_token: 'expired-native-token',
        refresh_token: 'native-refresh-token',
        expiry_date: Date.now() - 1_000
    };
    leaderId = 'leader';
    failNextLeaderRefresh = true;
    failoverAfterFailure = true;

    const fallbackCredentials = await factory.ensureCliNativeAuthenticated('codex');

    assert.equal(fallbackCredentials?.access_token, 'refreshed-token');
    assert.deepEqual(pathCalls, [`load:${nativePath}`, `refresh:${nativePath}`, `refresh:${nativePath}`]);

    pathCalls.length = 0;
    credentials = {
        access_token: 'unexpired-native-token',
        refresh_token: 'native-refresh-token',
        expiry_date: Date.now() + 60_000
    };
    leaderId = 'leader';
    failoverAfterFailure = false;

    const forcedCredentials = await factory.ensureCliNativeAuthenticated('codex', true);

    assert.equal(requestedForceRefresh, true);
    assert.equal(forcedCredentials?.access_token, 'refreshed-token');
    assert.deepEqual(pathCalls, [`load:${nativePath}`, `refresh:${nativePath}`, `load:${nativePath}`]);

    pathCalls.length = 0;
    factory.CLI_AUTH_REFRESH_TIMEOUT_MS = 1;
    dropNextLeaderRefresh = true;

    const timedOutCredentials = await factory.ensureCliNativeAuthenticated('codex', true);

    assert.equal(timedOutCredentials, null);
    assert.deepEqual(pathCalls, [`load:${nativePath}`]);
});
