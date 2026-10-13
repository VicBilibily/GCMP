import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { PublicationReport } from './worker';

export async function bounded<T>(
    work: Promise<T>,
    label: string,
    milliseconds = 15000,
    signal?: AbortSignal
): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                abort = () => reject(new Error(`Cancelled: ${label}`));
                if (signal?.aborted) {
                    abort();
                    return;
                }
                signal?.addEventListener('abort', abort, { once: true });
                timer = setTimeout(() => reject(new Error(`Deadline exceeded: ${label}`)), milliseconds);
            })
        ]);
    } finally {
        clearTimeout(timer);
        if (abort) {
            signal?.removeEventListener('abort', abort);
        }
    }
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
}

export function startWorker(dir: string, date: string) {
    const child = fork(fileURLToPath(new URL('./worker.ts', import.meta.url)), ['--publication-worker', dir, date], {
        cwd: fileURLToPath(new URL('../../../../../', import.meta.url)),
        execArgv: ['--import=tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    const prepared = deferred<Extract<PublicationReport, { kind: 'prepared' }>>();
    const saved = deferred<Extract<PublicationReport, { kind: 'saved' }>>();
    const closed = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
    let ended = false;
    let stderr = '';
    child.stdout?.resume();
    child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
    });
    const fail = (error: Error) => {
        prepared.reject(error);
        saved.reject(error);
    };
    child.on('error', fail);
    child.on('message', (message: PublicationReport) => {
        if (message.kind === 'prepared') {
            prepared.resolve(message);
        } else if (message.kind === 'saved') {
            saved.resolve(message);
        } else {
            fail(new Error(message.message));
        }
    });
    child.once('close', (code, signal) => {
        ended = true;
        closed.resolve({ code, signal });
        fail(new Error(`Worker closed before requested phase: ${code}/${signal}; ${stderr}`));
    });
    const send = (command: 'commit' | 'stop') =>
        new Promise<void>((resolve, reject) => {
            if (!child.connected) {
                reject(new Error(`Worker disconnected before ${command}`));
                return;
            }
            child.send(command, error => (error ? reject(error) : resolve()));
        });
    return {
        prepared: prepared.promise,
        saved: saved.promise,
        closed: closed.promise,
        send,
        async stop(): Promise<void> {
            if (ended) {
                return;
            }
            const result = await bounded(send('stop'), 'worker stop send', 3000).then(
                () => undefined,
                (error: unknown) => error
            );
            try {
                await bounded(closed.promise, 'worker stop exit', 10000);
            } catch (error) {
                if (!ended) {
                    child.kill();
                }
                await bounded(closed.promise, 'owned worker emergency exit', 5000);
                throw error;
            }
            const code = (result as NodeJS.ErrnoException | undefined)?.code;
            if (result !== undefined && code !== 'EPIPE' && code !== 'ERR_IPC_CHANNEL_CLOSED') {
                if (!(result instanceof Error && result.message.startsWith('Worker disconnected before'))) {
                    throw result;
                }
            }
        }
    };
}
