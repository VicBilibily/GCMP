import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { AtomicJsonFile } from '../usages/atomicJsonFile';

import {
    clearRateLimitLeaderHandoff,
    consumeRateLimitLeaderHandoff,
    writeRateLimitLeaderHandoff,
    type RateLimitLeaderHandoffPayload
} from './leaderHandoffFile';
import type { RateLimitStoreSnapshot } from './rateLimitStore';

function tempFilePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-handoff-test-'));
    return path.join(dir, 'rateLimit-handoff.json');
}

function snapshot(): RateLimitStoreSnapshot {
    return { buckets: [], grants: [] };
}

function payload(overrides?: Partial<RateLimitLeaderHandoffPayload>): RateLimitLeaderHandoffPayload {
    return {
        leaderId: 'leader-a',
        authorityTerm: 'leader-a:1',
        receivedAt: 100,
        snapshot: snapshot(),
        ...overrides
    };
}

test('consume returns undefined when file does not exist', async () => {
    assert.equal(await consumeRateLimitLeaderHandoff(tempFilePath()), undefined);
});

test('write then consume round-trips payload and deletes the file', async () => {
    const filePath = tempFilePath();
    const info = payload();
    await writeRateLimitLeaderHandoff(info, filePath);

    assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath), info);
    assert.equal(fs.existsSync(filePath), false);
    assert.equal(await consumeRateLimitLeaderHandoff(filePath), undefined);
});

test('recovery read can preserve valid state until a later authority publishes its snapshot', async () => {
    const filePath = tempFilePath();
    const info = payload();
    const recoveryOptions = { strict: true, preserve: true };
    await writeRateLimitLeaderHandoff(info, filePath, { strict: true });
    assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath, recoveryOptions), info);
    assert.equal(fs.existsSync(filePath), true);
    assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath, recoveryOptions), info);
    assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath), info);
    assert.equal(fs.existsSync(filePath), false);
});

test('newer receivedAt is not overwritten by an older write', async () => {
    const filePath = tempFilePath();
    await writeRateLimitLeaderHandoff(payload({ leaderId: 'newer', receivedAt: 200 }), filePath);
    await writeRateLimitLeaderHandoff(payload({ leaderId: 'older', receivedAt: 100 }), filePath);

    assert.equal((await consumeRateLimitLeaderHandoff(filePath))?.leaderId, 'newer');
});

test('consume deletes corrupted content and returns undefined', async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(filePath, 'not-json', 'utf8');
    assert.equal(await consumeRateLimitLeaderHandoff(filePath), undefined);
    assert.equal(fs.existsSync(filePath), false);
});

test('clear removes an existing handoff file', async () => {
    const filePath = tempFilePath();
    await writeRateLimitLeaderHandoff(payload(), filePath);
    await clearRateLimitLeaderHandoff(filePath);
    assert.equal(fs.existsSync(filePath), false);
});

test('background handoff writes remain best-effort on an actual filesystem failure', async () => {
    const blockedPath = tempFilePath();
    fs.writeFileSync(blockedPath, 'blocked', 'utf8');
    await assert.doesNotReject(writeRateLimitLeaderHandoff(payload(), path.join(blockedPath, 'handoff.json')));
    assert.equal(fs.readFileSync(blockedPath, 'utf8'), 'blocked');
});

test('strict handoff writes propagate an actual filesystem failure', async () => {
    const blockedPath = tempFilePath();
    fs.writeFileSync(blockedPath, 'blocked', 'utf8');
    await assert.rejects(
        writeRateLimitLeaderHandoff(payload(), path.join(blockedPath, 'handoff.json'), { strict: true })
    );
    assert.equal(fs.readFileSync(blockedPath, 'utf8'), 'blocked');
});

for (const { sameTerm, operation } of [
    { sameTerm: false, operation: 'write' },
    { sameTerm: true, operation: 'write' },
    { sameTerm: false, operation: 'consume' },
    { sameTerm: false, operation: 'clear' },
    { sameTerm: false, operation: 'crash' }
]) {
    test(
        `cross-process delayed write serializes with ${operation}; sameTerm=${sameTerm}`,
        { timeout: 20_000 },
        async () => {
            const filePath = tempFilePath();
            const moduleUrl = pathToFileURL(path.resolve('src/rateLimit/leaderHandoffFile.ts')).href;
            const atomicUrl = pathToFileURL(path.resolve('src/usages/atomicJsonFile.ts')).href;
            const script = `
            import fs from 'node:fs/promises';
            const [filePath, kind, authorityTerm, operation] = process.argv.slice(1);
            const atomicModule = await import(${JSON.stringify(atomicUrl)});
            const handoffModule = await import(${JSON.stringify(moduleUrl)});
            const { AtomicJsonFile } = atomicModule.default ?? atomicModule;
            const { writeRateLimitLeaderHandoff, consumeRateLimitLeaderHandoff, clearRateLimitLeaderHandoff } = handoffModule.default ?? handoffModule;
            const originalWrite = AtomicJsonFile.writeJsonAtomically;
            const originalScan = fs.readdir;
            fs.readdir = async (...args) => {
                const result = await originalScan(...args);
                if (kind === 'new') process.send?.('coordinating');
                return result;
            };
            AtomicJsonFile.writeJsonAtomically = async (...args) => {
                if (kind === 'old' && args[0] === filePath) {
                    process.send?.('paused');
                    await new Promise(resolve => process.once('message', resolve));
                }
                return originalWrite.apply(AtomicJsonFile, args);
            };
            if (kind === 'new' && operation === 'consume') {
                const consumed = await consumeRateLimitLeaderHandoff(filePath, { strict: true });
                process.stdout.write(JSON.stringify({ consumed: consumed?.receivedAt ?? null }));
            } else if (kind === 'new' && operation === 'clear') await clearRateLimitLeaderHandoff(filePath);
            else await writeRateLimitLeaderHandoff({
                leaderId: kind, authorityTerm, receivedAt: kind === 'old' ? 100 : 200,
                snapshot: { buckets: [], grants: [] }
            }, filePath, { strict: true });
            process.send?.('written');
            process.disconnect();
        `;
            const children: ChildProcess[] = [];
            function launch(
                kind: string,
                term: string
            ): {
                child: ChildProcess;
                wait: (value: string) => Promise<void>;
                done: Promise<void>;
                output: () => string;
            } {
                const child = spawn(
                    process.execPath,
                    ['--import=tsx', '--input-type=module', '--eval', script, filePath, kind, term, operation],
                    {
                        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
                    }
                );
                children.push(child);
                let output = '';
                child.stdout?.on('data', chunk => {
                    output += String(chunk);
                });
                child.stderr?.on('data', chunk => {
                    output += String(chunk);
                });
                const seen = new Set<string>();
                const pending = new Map<string, Array<() => void>>();
                child.on('message', message => {
                    if (typeof message !== 'string') {
                        return;
                    }
                    seen.add(message);
                    for (const resolve of pending.get(message) ?? []) {
                        resolve();
                    }
                });
                const done = new Promise<void>((resolve, reject) => {
                    child.once('error', reject);
                    child.once('exit', (code, signal) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Worker ${kind} exited ${code}/${signal}: ${output}`));
                        }
                    });
                });
                void done.catch(() => {});
                return {
                    child,
                    done,
                    output: () => output,
                    wait: value =>
                        seen.has(value) ?
                            Promise.resolve()
                        :   new Promise<void>(resolve => {
                                pending.set(value, [...(pending.get(value) ?? []), resolve]);
                            })
                };
            }
            try {
                const old = launch('old', 'owner:1');
                await Promise.race([
                    old.wait('paused'),
                    old.done.then(() => {
                        throw new Error('Old writer never paused');
                    })
                ]);
                if (operation === 'crash') {
                    old.child.kill();
                    await assert.rejects(old.done);
                }
                const newer = launch('new', sameTerm ? 'owner:1' : 'owner:2');
                if (operation === 'crash') {
                    await newer.done;
                } else {
                    await Promise.race([newer.wait('coordinating'), newer.done]);
                    old.child.send('resume');
                    await Promise.all([old.done, newer.done]);
                }
                if (operation === 'write' || operation === 'crash') {
                    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).receivedAt, 200);
                    assert.equal((await consumeRateLimitLeaderHandoff(filePath))?.leaderId, 'new');
                    assert.deepEqual(fs.readdirSync(`${filePath}.lock`), []);
                } else {
                    assert.equal(fs.existsSync(filePath), false);
                    if (operation === 'consume') {
                        assert.equal(JSON.parse(newer.output()).consumed, 100);
                    }
                }
            } finally {
                for (const child of children) {
                    if (child.exitCode === null && child.signalCode === null) {
                        child.kill();
                    }
                }
            }
        }
    );
}

test('strict consume propagates a real read failure; background consume stays best-effort', async () => {
    const filePath = tempFilePath();
    fs.mkdirSync(filePath);
    await assert.rejects(consumeRateLimitLeaderHandoff(filePath, { strict: true }));
    assert.equal(await consumeRateLimitLeaderHandoff(filePath), undefined);
    assert.equal(fs.statSync(filePath).isDirectory(), true);
});

test('tickets left by an exited OS process are reclaimed', async () => {
    const filePath = tempFilePath();
    const pid = Number(
        execFileSync(process.execPath, ['--eval', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    );
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    assert.throws(() => process.kill(pid, 0));
    fs.mkdirSync(`${filePath}.lock`);
    const abandoned = path.join(`${filePath}.lock`, `${pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`);
    fs.writeFileSync(abandoned, '');
    await writeRateLimitLeaderHandoff(payload(), filePath, { strict: true });
    assert.equal(fs.existsSync(abandoned), false);
    assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath), payload());
});

test('old tickets owned by a live process are not stolen based on age', async () => {
    const filePath = tempFilePath();
    const lockPath = `${filePath}.lock`;
    fs.mkdirSync(lockPath);
    const live = path.join(lockPath, `${process.pid}-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json`);
    fs.writeFileSync(live, JSON.stringify({ choosing: false, number: 1 }));
    fs.utimesSync(live, new Date(0), new Date(0));
    let published!: () => void;
    const ticketReady = new Promise<void>(resolve => {
        published = resolve;
    });
    const originalWrite = AtomicJsonFile.writeJsonAtomically;
    let writing: Promise<void> | undefined;
    try {
        AtomicJsonFile.writeJsonAtomically = async (...args) => {
            await originalWrite.apply(AtomicJsonFile, args);
            if (path.dirname(args[0]) === lockPath) {
                published();
            }
        };
        let completed = false;
        writing = writeRateLimitLeaderHandoff(payload(), filePath, { strict: true }).then(() => {
            completed = true;
        });
        await ticketReady;
        assert.equal(completed, false);
        assert.equal(fs.existsSync(live), true);
        assert.equal(fs.existsSync(filePath), false);
        fs.unlinkSync(live);
        await writing;
        assert.deepEqual(await consumeRateLimitLeaderHandoff(filePath), payload());
    } finally {
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        fs.rmSync(live, { force: true });
        await writing?.catch(() => {});
    }
});
