import assert from 'node:assert/strict';

import { DashscopeMCPWebSearchClient } from '../../src/tools/mcp/dashscopeMCPClient';

interface DashscopeMCPClientTestAccess {
    isConnecting: boolean;
    connectionPromise: Promise<void> | null;
    initializeClient: () => Promise<void>;
    internalCleanup: () => Promise<void>;
    scheduleCleanupAfterIdle: () => void;
    ensureConnected: () => Promise<void>;
    cleanup: () => Promise<void>;
}

type DashscopeMCPClientConstructor = new () => DashscopeMCPClientTestAccess;

suite('DashScope MCP client lifecycle', () => {
    test('defers stale cleanup until an in-flight connection finishes', async () => {
        const client = new (DashscopeMCPWebSearchClient as unknown as DashscopeMCPClientConstructor)();
        let resolveConnection: (() => void) | undefined;
        let cleanupCalls = 0;
        let scheduledCleanupCalls = 0;

        client.initializeClient = () =>
            new Promise<void>(resolve => {
                resolveConnection = resolve;
            });
        client.internalCleanup = async () => {
            cleanupCalls += 1;
        };
        client.scheduleCleanupAfterIdle = () => {
            scheduledCleanupCalls += 1;
        };

        const connection = client.ensureConnected();
        assert.equal(client.isConnecting, true);

        await client.cleanup();
        assert.equal(cleanupCalls, 0);

        assert.ok(resolveConnection);
        resolveConnection();
        await connection;

        assert.equal(client.isConnecting, false);
        assert.equal(client.connectionPromise, null);
        assert.equal(scheduledCleanupCalls, 1);
    });
});
