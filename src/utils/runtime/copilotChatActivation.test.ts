import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as {
    prototype: { require: (id: string) => unknown };
};

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

test('Copilot Chat background activation refresh lifecycle', async t => {
    let extension: { activate: () => Promise<unknown> } | undefined;
    let lookupError: Error | undefined;
    const warnings: string[] = [];

    class Disposable {
        constructor(private readonly callback: () => void) {}

        dispose(): void {
            this.callback();
        }
    }

    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return {
                Disposable,
                extensions: {
                    getExtension: () => {
                        if (lookupError) {
                            throw lookupError;
                        }
                        return extension;
                    }
                }
            };
        }
        if (id.endsWith('/logger')) {
            return { Logger: { warn: (message: string) => warnings.push(message) } };
        }
        return originalRequire.call(this, id);
    };

    let activationModule: typeof import('./copilotChatActivation');
    try {
        activationModule = await import('./copilotChatActivation');
    } finally {
        NodeModule.prototype.require = originalRequire;
    }

    const reset = (): void => {
        extension = undefined;
        lookupError = undefined;
        warnings.length = 0;
    };

    await t.test('returns immediately and refreshes after activation resolves', async () => {
        reset();
        const activation = deferred();
        let refreshes = 0;
        extension = { activate: () => activation.promise };

        const disposable = activationModule.activateCopilotChatInBackground(() => {
            refreshes++;
        });
        assert.equal(refreshes, 0);

        activation.resolve();
        await activation.promise;
        await Promise.resolve();
        assert.equal(refreshes, 1);
        assert.deepEqual(warnings, []);
        disposable.dispose();
    });

    await t.test('does nothing when Copilot Chat is not installed', async () => {
        reset();
        let refreshes = 0;
        activationModule
            .activateCopilotChatInBackground(() => {
                refreshes++;
            })
            .dispose();
        await Promise.resolve();

        assert.equal(refreshes, 0);
        assert.deepEqual(warnings, []);
    });

    await t.test('handles activation rejection without refreshing', async () => {
        reset();
        const activation = deferred();
        let refreshes = 0;
        extension = { activate: () => activation.promise };
        const disposable = activationModule.activateCopilotChatInBackground(() => {
            refreshes++;
        });

        activation.reject(new Error('authentication unavailable'));
        await assert.rejects(activation.promise, /authentication unavailable/);
        await Promise.resolve();

        assert.equal(refreshes, 0);
        assert.deepEqual(warnings, ['Copilot Chat activation unavailable; model information refresh may be delayed']);
        disposable.dispose();
    });

    await t.test('reports model refresh failures separately from activation failures', async () => {
        reset();
        const activation = deferred();
        extension = { activate: () => activation.promise };
        const disposable = activationModule.activateCopilotChatInBackground(() => {
            throw new Error('refresh failed');
        });

        activation.resolve();
        await activation.promise;
        await Promise.resolve();

        assert.deepEqual(warnings, ['Model information refresh failed after Copilot Chat activation']);
        disposable.dispose();
    });

    await t.test('ignores activation completion after disposal', async () => {
        reset();
        const activation = deferred();
        let refreshes = 0;
        extension = { activate: () => activation.promise };
        const disposable = activationModule.activateCopilotChatInBackground(() => {
            refreshes++;
        });

        disposable.dispose();
        activation.resolve();
        await activation.promise;
        await Promise.resolve();

        assert.equal(refreshes, 0);
        assert.deepEqual(warnings, []);
    });

    await t.test('ignores activation rejection after disposal', async () => {
        reset();
        const activation = deferred();
        let refreshes = 0;
        extension = { activate: () => activation.promise };
        const disposable = activationModule.activateCopilotChatInBackground(() => {
            refreshes++;
        });

        disposable.dispose();
        activation.reject(new Error('late activation failure'));
        await assert.rejects(activation.promise, /late activation failure/);
        await Promise.resolve();

        assert.equal(refreshes, 0);
        assert.deepEqual(warnings, []);
    });

    await t.test('handles synchronous extension lookup failure', async () => {
        reset();
        lookupError = new Error('extension host unavailable');
        let refreshes = 0;
        const disposable = activationModule.activateCopilotChatInBackground(() => {
            refreshes++;
        });
        await Promise.resolve();

        assert.equal(refreshes, 0);
        assert.deepEqual(warnings, ['Copilot Chat activation unavailable; model information refresh may be delayed']);
        disposable.dispose();
    });
});
