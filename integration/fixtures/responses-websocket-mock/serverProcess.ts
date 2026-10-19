import * as protocolNamespace from '../responsesWebSocketMockProcess.js';
import type { MockCommand, MockReply } from '../responsesWebSocketMockProcess.js';
import { startResponsesMockServer } from './mockServer.js';

const { isMockCommand } = (
    'default' in protocolNamespace ?
        protocolNamespace.default
    :   protocolNamespace) as typeof protocolNamespace;
let server: Awaited<ReturnType<typeof startResponsesMockServer>> | undefined;
let starting = false;

function reply(value: MockReply, finish = false): void {
    if (!process.connected || !process.send) {
        return;
    }
    process.send(value, error => {
        if (error) {
            process.exitCode = 1;
        }
        if (finish && process.connected) {
            process.disconnect?.();
        }
    });
}

async function handle(command: MockCommand): Promise<void> {
    if (command.kind === 'start') {
        if (starting) {
            throw new Error('Mock already started');
        }
        starting = true;
        server = await startResponsesMockServer(command.scenario, command.expected, command.network);
        reply({ id: command.id, kind: 'ready', url: server.url, origin: server.origin, proxyUrl: server.proxyUrl });
        return;
    }
    if (!server) {
        throw new Error('Mock is not ready');
    }
    switch (command.kind) {
        case 'snapshot':
            reply({ id: command.id, kind: 'snapshot', snapshot: server.snapshot() });
            break;
        case 'wait':
            await server.waitFor(command.expected);
            reply({ id: command.id, kind: 'ack' });
            break;
        case 'release':
            server.releasePending();
            reply({ id: command.id, kind: 'ack' });
            break;
        case 'idle':
            server.sendIdleEvent();
            reply({ id: command.id, kind: 'ack' });
            break;
        case 'stop':
            await server.stop();
            process.exitCode = 0;
            reply({ id: command.id, kind: 'stopped', snapshot: server.snapshot() }, true);
            break;
    }
}

process.on('message', (value: unknown) => {
    if (!isMockCommand(value)) {
        process.exitCode = 1;
        if (process.connected) {
            process.disconnect?.();
        }
        return;
    }
    void handle(value).catch(() => reply({ id: value.id, kind: 'error', code: 'mock_command_failed' }));
});
process.on('disconnect', () => {
    void server?.stop().catch(() => {
        process.exitCode = 1;
    });
});
