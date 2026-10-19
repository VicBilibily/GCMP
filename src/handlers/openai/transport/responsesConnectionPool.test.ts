import assert from 'node:assert/strict';
import test from 'node:test';
import { ResponsesConnectionPool } from './responsesConnectionPool';
import type { ResponsesClock, ResponsesConnection, ResponsesConnectionIdentity } from './responsesConnectionPool';

class Clock implements ResponsesClock {
    time = 0;
    tasks = new Set<{ at: number; run: () => void }>();
    now() {
        return this.time;
    }
    schedule(run: () => void, delay: number) {
        const task = { at: this.time + delay, run };
        this.tasks.add(task);
        return () => {
            this.tasks.delete(task);
        };
    }
    advance(delay: number) {
        this.time += delay;
        for (const task of [...this.tasks]) {
            if (task.at <= this.time && this.tasks.delete(task)) {
                task.run();
            }
        }
    }
}

class Connection implements ResponsesConnection {
    opened = Promise.resolve();
    reusable = true;
    closeCalls = 0;
    interrupts = 0;
    private finish!: () => void;
    closed = new Promise<void>(resolve => {
        this.finish = resolve;
    });
    close() {
        this.closeCalls++;
        this.reusable = false;
        return this.closed;
    }
    interrupt() {
        this.interrupts++;
    }
    confirmClose() {
        this.finish();
    }
}

const identity: ResponsesConnectionIdentity = {
    ownerId: 'owner',
    provider: 'provider',
    modelId: 'model',
    sessionId: 'session',
    origin: 'sdk',
    purpose: 'chat',
    branchId: 'main',
    binding: 'synthetic-binding'
};

function failureRecords(pool: ResponsesConnectionPool): ReadonlyMap<string, { times: number[] }> {
    return (pool as unknown as { failures: Map<string, { times: number[] }> }).failures;
}

test('WS-LOOP-15: failure records expire without another request and share one cleanup timer', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    try {
        for (let index = 0; index < 100; index++) {
            pool.recordResult({ ...identity, sessionId: `failed-${index}` }, true);
        }
        assert.equal(failureRecords(pool).size, 100);
        assert.equal(clock.tasks.size, 1);
        clock.advance(299_999);
        assert.equal(failureRecords(pool).size, 100);
        clock.advance(1);
        assert.equal(failureRecords(pool).size, 0);
        assert.equal(clock.tasks.size, 0);
    } finally {
        await pool.dispose();
    }
});

test('WS-LOOP-15: a later failure refreshes only its own retention window', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    try {
        pool.recordResult(identity, true);
        pool.recordResult({ ...identity, sessionId: 'other' }, true);
        clock.advance(100_000);
        pool.recordResult(identity, true);
        clock.advance(200_000);
        assert.equal(failureRecords(pool).size, 1);
        clock.advance(99_999);
        assert.equal(failureRecords(pool).size, 1);
        clock.advance(1);
        assert.equal(failureRecords(pool).size, 0);
        assert.equal(clock.tasks.size, 0);
    } finally {
        await pool.dispose();
    }
});

test('WS-LOOP-15: failure capacity preserves existing breakers and reopens after expiry', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const signal = new AbortController().signal;
    const connection = new Connection();
    const unexpected = () => {
        throw new Error('Failure capacity or circuit was bypassed');
    };
    try {
        for (let index = 0; index < 1024; index++) {
            for (let attempt = 0; attempt < 3; attempt++) {
                pool.recordResult({ ...identity, sessionId: `failed-${index}` }, true);
            }
        }
        pool.recordResult(identity, true);
        assert.equal(failureRecords(pool).size, 1024);
        assert.equal(clock.tasks.size, 1);
        assert.equal(await pool.acquire(identity, unexpected, signal), undefined);
        assert.equal(await pool.acquire({ ...identity, sessionId: 'failed-0' }, unexpected, signal), undefined);
        clock.advance(300_000);
        assert.equal(failureRecords(pool).size, 0);
        const lease = await pool.acquire(identity, () => connection, signal);
        assert.ok(lease);
        lease.release(false);
    } finally {
        connection.confirmClose();
        await pool.dispose();
    }
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: failure timestamps stay bounded without resetting the cooldown', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    try {
        for (let index = 0; index < 100; index++) {
            pool.recordResult(identity, true);
        }
        assert.equal(failureRecords(pool).size, 1);
        assert.equal([...failureRecords(pool).values()][0].times.length, 3);
        assert.equal(
            await pool.acquire(
                identity,
                () => {
                    throw new Error('Circuit was bypassed');
                },
                new AbortController().signal
            ),
            undefined
        );
    } finally {
        await pool.dispose();
    }
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: owner disposal removes only its failures and ignores late results', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const other = { ...identity, ownerId: 'other' };
    try {
        pool.recordResult(identity, true);
        for (let attempt = 0; attempt < 3; attempt++) {
            pool.recordResult(other, true);
        }
        await pool.disposeOwner(identity.ownerId);
        pool.recordResult(identity, true);
        assert.equal(failureRecords(pool).size, 1);
        assert.equal(
            await pool.acquire(
                other,
                () => {
                    throw new Error('Other owner circuit was removed');
                },
                new AbortController().signal
            ),
            undefined
        );
        await pool.disposeOwner(other.ownerId);
        pool.recordResult(other, true);
        assert.equal(failureRecords(pool).size, 0);
        assert.equal(clock.tasks.size, 0);
    } finally {
        await pool.dispose();
    }
});

test('WS-LOOP-15: pool disposal clears failures and ignores late results', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    pool.recordResult(identity, true);
    await pool.dispose();
    assert.equal(failureRecords(pool).size, 0);
    pool.recordResult(identity, true);
    assert.equal(failureRecords(pool).size, 0);
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: failure expiry cannot admit another half-open probe', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const connection = new Connection();
    let open!: () => void;
    connection.opened = new Promise<void>(resolve => {
        open = resolve;
    });
    const signal = new AbortController().signal;
    for (let attempt = 0; attempt < 3; attempt++) {
        pool.recordResult(identity, true);
    }
    clock.advance(60_000);
    const pending = pool.acquire(identity, () => connection, signal);
    try {
        clock.advance(240_000);
        assert.equal(failureRecords(pool).size, 1);
        assert.equal(
            await pool.acquire(
                identity,
                () => {
                    throw new Error('Duplicate half-open probe');
                },
                signal,
                true
            ),
            undefined
        );
        open();
        const lease = await pending;
        assert.ok(lease);
        assert.equal(failureRecords(pool).size, 0);
        lease.release(false);
    } finally {
        open();
        (await pending)?.release(false);
        connection.confirmClose();
        await pool.dispose();
    }
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: full failure capacity still permits healthy reuse and known recovery probes', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const signal = new AbortController().signal;
    const healthy = new Connection();
    const recovered = new Connection();
    const fresh = new Connection();
    try {
        (await pool.acquire(identity, () => healthy, signal))?.release(true);
        for (let index = 0; index < 1024; index++) {
            for (let attempt = 0; attempt < 3; attempt++) {
                pool.recordResult({ ...identity, sessionId: `failed-${index}` }, true);
            }
        }
        const reused = await pool.acquire(
            identity,
            () => {
                throw new Error('Healthy connection replaced');
            },
            signal
        );
        assert.equal(reused?.connection, healthy);
        reused?.release(true);
        clock.advance(60_000);
        const probe = await pool.acquire({ ...identity, sessionId: 'failed-0' }, () => recovered, signal);
        assert.ok(probe);
        assert.equal(failureRecords(pool).size, 1023);
        probe.release(true);
        const next = await pool.acquire({ ...identity, sessionId: 'new' }, () => fresh, signal);
        assert.ok(next);
        next.release(true);
    } finally {
        const cleanup = pool.dispose();
        for (const connection of [healthy, recovered, fresh]) {
            connection.confirmClose();
        }
        await cleanup;
    }
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: non-transport results remove failure records and their cleanup timer', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    try {
        pool.recordResult(identity, true);
        pool.recordResult(identity, false);
        assert.equal(failureRecords(pool).size, 0);
        assert.equal(clock.tasks.size, 0);
    } finally {
        await pool.dispose();
    }
});

for (const outcome of ['failed', 'cancelled'] as const) {
    test(`WS-LOOP-15: expired half-open ${outcome} probe releases old failure history`, async () => {
        const clock = new Clock();
        const pool = new ResponsesConnectionPool(clock);
        const connection = new Connection();
        const controller = new AbortController();
        let rejectOpen!: (error: Error) => void;
        connection.opened = new Promise<void>((_resolve, reject) => {
            rejectOpen = reject;
        });
        for (let attempt = 0; attempt < 3; attempt++) {
            pool.recordResult(identity, true);
        }
        clock.advance(60_000);
        const pending = pool.acquire(identity, () => connection, controller.signal);
        const rejected = assert.rejects(pending, /probe failed|probe cancelled|cleanup/);
        try {
            clock.advance(240_000);
            assert.equal(failureRecords(pool).size, 1);
            if (outcome === 'cancelled') {
                controller.abort();
            }
            rejectOpen(new Error(`probe ${outcome}`));
            await rejected;
            assert.equal(failureRecords(pool).size, 0);
            assert.equal(clock.tasks.size, 0);
            pool.recordResult(identity, true);
            assert.equal(failureRecords(pool).size, 1);
            assert.equal([...failureRecords(pool).values()][0].times.length, 1);
            clock.advance(300_000);
            assert.equal(failureRecords(pool).size, 0);
        } finally {
            rejectOpen(new Error('cleanup'));
            await rejected;
            connection.confirmClose();
            await pool.dispose();
        }
        assert.equal(clock.tasks.size, 0);
    });
}

test('WS-LOOP-15: circuit half-open admits one user probe and reopens on failure', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const signal = new AbortController().signal;
    let creates = 0;
    const connections: Connection[] = [];
    const create = () => {
        creates++;
        const connection = new Connection();
        connections.push(connection);
        return connection;
    };
    for (let index = 0; index < 3; index++) {
        pool.recordResult(identity, true);
    }
    assert.equal(await pool.acquire(identity, create, signal), undefined);
    assert.equal(creates, 0);
    const other = await pool.acquire({ ...identity, provider: 'other' }, create, signal);
    assert.ok(other);
    other.release(false);
    connections[0].confirmClose();
    clock.advance(60_000);
    let rejectProbe!: (error: Error) => void;
    const probe = pool.acquire(
        identity,
        () => {
            const connection = create();
            connection.opened = new Promise<void>((_resolve, reject) => {
                rejectProbe = reject;
            });
            return connection;
        },
        signal
    );
    assert.equal(await pool.acquire(identity, create, signal, true), undefined);
    assert.equal(creates, 2);
    rejectProbe(new Error('probe handshake failed'));
    await assert.rejects(probe, /probe handshake failed/);
    pool.recordResult(identity, true);
    connections[1].confirmClose();
    assert.equal(await pool.acquire(identity, create, signal), undefined);
    clock.advance(60_000);
    const recovered = await pool.acquire(identity, create, signal);
    assert.ok(recovered);
    recovered.release(true);
    assert.equal((await pool.acquire(identity, create, signal))?.connection, recovered.connection);
    const cleanup = pool.dispose();
    connections.forEach(connection => connection.confirmClose());
    await cleanup;
    assert.equal(clock.tasks.size, 0);
    assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
});

test('WS-LOOP-15: obsolete idle deadline cannot close a newly borrowed lease', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock, { idleMs: 100 });
    const connection = new Connection();
    const signal = new AbortController().signal;
    const first = await pool.acquire(identity, () => connection, signal);
    first?.release(true);
    clock.advance(99);
    const next = await pool.acquire(
        identity,
        () => {
            throw new Error('Unexpected replacement');
        },
        signal
    );
    assert.ok(next);
    clock.advance(1);
    assert.equal(connection.closeCalls, 0);
    assert.equal(next.isCurrent(), true);
    next.release(true);
    clock.advance(100);
    assert.equal(connection.closeCalls, 1);
    connection.confirmClose();
    await pool.dispose();
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: provider and global caps count active and closing sockets', async () => {
    const pool = new ResponsesConnectionPool(undefined, { maximum: 3, perProvider: 2 });
    const signal = new AbortController().signal;
    const connections: Connection[] = [];
    const create = () => {
        const connection = new Connection();
        connections.push(connection);
        return connection;
    };
    const first = await pool.acquire(identity, create, signal);
    const second = await pool.acquire({ ...identity, sessionId: 'second' }, create, signal);
    assert.equal(await pool.acquire({ ...identity, sessionId: 'third' }, create, signal), undefined);
    const third = await pool.acquire({ ...identity, provider: 'other' }, create, signal);
    assert.ok(first && second && third);
    first.release(false);
    assert.equal(await pool.acquire({ ...identity, provider: 'third' }, create, signal), undefined);
    assert.equal(connections.length, 3);
    connections[0].confirmClose();
    await Promise.resolve();
    const fourth = await pool.acquire({ ...identity, provider: 'third' }, create, signal);
    assert.ok(fourth);
    const cleanup = pool.dispose();
    connections.forEach(connection => connection.confirmClose());
    await cleanup;
    assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
});

test('WS-LOOP-15: partial close failure still closes peers and retains failed registration', async () => {
    const pool = new ResponsesConnectionPool();
    const broken = new Connection();
    const healthy = new Connection();
    broken.close = () => {
        broken.closeCalls++;
        throw new Error('injected close failure');
    };
    const signal = new AbortController().signal;
    await pool.acquire(identity, () => broken, signal);
    await pool.acquire({ ...identity, sessionId: 'other' }, () => healthy, signal);
    const cleanup = pool.dispose();
    assert.equal(pool.dispose(), cleanup);
    healthy.confirmClose();
    await assert.rejects(cleanup, AggregateError);
    assert.equal(broken.closeCalls, 1);
    assert.equal(healthy.closeCalls, 1);
    assert.equal(pool.diagnostics().connections, 1);
    broken.confirmClose();
    await Promise.resolve();
    assert.equal(pool.diagnostics().connections, 0);
});

test('WS-LOOP-17: sequential requests reuse while provider/model/session/binding isolate', async () => {
    const pool = new ResponsesConnectionPool();
    const connections: Connection[] = [];
    const create = () => {
        const connection = new Connection();
        connections.push(connection);
        return connection;
    };
    const signal = new AbortController().signal;
    const first = await pool.acquire(identity, create, signal);
    assert.ok(first);
    first.release(true);
    const next = await pool.acquire({ ...identity }, create, signal);
    assert.equal(next?.connection, first.connection);
    next?.release(true);
    for (const field of ['provider', 'modelId', 'sessionId', 'binding', 'ownerId', 'branchId'] as const) {
        const isolated = await pool.acquire({ ...identity, [field]: 'other' }, create, signal);
        assert.notEqual(isolated?.connection, first.connection);
        isolated?.release(false);
    }
    const disposal = pool.dispose();
    connections.forEach(connection => connection.confirmClose());
    await disposal;
    assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
});

test('WS-LOOP-15: closing connections retain capacity until physical close', async () => {
    const pool = new ResponsesConnectionPool(undefined, { maximum: 1 });
    const connection = new Connection();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(identity, () => connection, signal);
    lease?.release(false);
    assert.deepEqual(pool.diagnostics(), { connections: 1, leases: 0, closing: 1 });
    assert.equal(
        await pool.acquire(
            identity,
            () => {
                throw new Error('over capacity');
            },
            signal
        ),
        undefined
    );
    connection.confirmClose();
    await connection.closed;
    assert.equal(pool.diagnostics().connections, 0);
    await pool.dispose();
});

test('WS-LOOP-07: busy lease denies reuse without replacing connection', async () => {
    const pool = new ResponsesConnectionPool();
    const connection = new Connection();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(identity, () => connection, signal);
    assert.equal(
        await pool.acquire(
            identity,
            () => {
                throw new Error('replaced busy');
            },
            signal
        ),
        undefined
    );
    assert.equal(connection.closeCalls, 0);
    lease?.release(true);
    const disposal = pool.dispose();
    connection.confirmClose();
    await disposal;
});

test('WS-LOOP-07: isolated busy lease retains caps and closes without replacing the reusable connection', async () => {
    const pool = new ResponsesConnectionPool(undefined, { maximum: 2, perProvider: 2 });
    const signal = new AbortController().signal;
    const original = new Connection();
    const isolated = new Connection();
    const lease = await pool.acquire(identity, () => original, signal, true);
    const concurrent = await pool.acquire(identity, () => isolated, signal, true);
    assert.ok(lease && concurrent);
    assert.notEqual(concurrent.connection, lease.connection);
    assert.notEqual(concurrent.generation, lease.generation);
    const overCapacity = () => {
        throw new Error('Created a connection beyond capacity');
    };
    assert.equal(await pool.acquire(identity, overCapacity, signal, true), undefined);
    concurrent.release(true);
    assert.equal(isolated.closeCalls, 1);
    assert.equal(original.closeCalls, 0);
    assert.equal(lease.isCurrent(), true);
    assert.equal(await pool.acquire(identity, overCapacity, signal, true), undefined);
    isolated.confirmClose();
    await isolated.closed;
    lease.release(true);
    const next = await pool.acquire(identity, overCapacity, signal, true);
    assert.equal(next?.connection, original);
    const cleanup = pool.dispose();
    original.confirmClose();
    await cleanup;
    assert.deepEqual(pool.diagnostics(), { connections: 0, leases: 0, closing: 0 });
});

test('WS-LOOP-15: soft lifetime expiry lets active request finish but denies reuse', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock, { lifetimeMs: 100, requestMs: 200 });
    const connection = new Connection();
    const lease = await pool.acquire(identity, () => connection, new AbortController().signal);
    clock.advance(100);
    assert.equal(lease?.isCurrent(), false);
    assert.equal(connection.interrupts, 0);
    lease?.release(true);
    assert.equal(connection.closeCalls, 1);
    connection.confirmClose();
    await pool.dispose();
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: total deadline is not extended and idle deadline recycles', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock, { idleMs: 20, requestMs: 100 });
    const connection = new Connection();
    const lease = await pool.acquire(identity, () => connection, new AbortController().signal);
    clock.advance(100);
    assert.equal(connection.interrupts, 1);
    lease?.release(false);
    connection.confirmClose();
    await connection.closed;
    const second = new Connection();
    const next = await pool.acquire(identity, () => second, new AbortController().signal);
    next?.release(true);
    clock.advance(20);
    assert.equal(second.closeCalls, 1);
    second.confirmClose();
    await pool.dispose();
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-15: stale cancellation and release do not affect next request', async () => {
    const clock = new Clock();
    const pool = new ResponsesConnectionPool(clock);
    const connection = new Connection();
    const old = new AbortController();
    const lease = await pool.acquire(identity, () => connection, old.signal);
    lease?.release(true);
    const next = await pool.acquire(identity, () => connection, new AbortController().signal);
    old.abort();
    lease?.release(false);
    assert.equal(next?.isCurrent(), true);
    assert.equal(connection.closeCalls, 0);
    assert.equal(connection.interrupts, 0);
    next?.release(true);
    const disposal = pool.dispose();
    connection.confirmClose();
    await disposal;
    assert.equal(clock.tasks.size, 0);
});

test('WS-LOOP-07: connecting request remains exclusive before open', async () => {
    const pool = new ResponsesConnectionPool();
    const connection = new Connection();
    let open!: () => void;
    connection.opened = new Promise<void>(resolve => {
        open = resolve;
    });
    connection.reusable = false;
    const signal = new AbortController().signal;
    const pending = pool.acquire(identity, () => connection, signal).catch(() => undefined);
    try {
        assert.equal(
            await pool.acquire(
                identity,
                () => {
                    throw new Error('duplicate handshake');
                },
                signal
            ),
            undefined
        );
        assert.equal(connection.closeCalls, 0);
    } finally {
        connection.reusable = true;
        open();
        (await pending)?.release(false);
        connection.confirmClose();
        await pool.dispose();
    }
});

test('WS-LOOP-12: completed consumer retains lease after physical disconnect', async () => {
    const pool = new ResponsesConnectionPool();
    const connection = new Connection();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(identity, () => connection, signal);
    try {
        connection.confirmClose();
        await connection.closed;
        assert.equal(
            await pool.acquire(
                identity,
                () => {
                    throw new Error('overlapping consumer');
                },
                signal
            ),
            undefined
        );
    } finally {
        lease?.release(false);
        await pool.dispose();
    }
});

test('WS-LOOP-17: disabling one model does not retire another model', async () => {
    const pool = new ResponsesConnectionPool();
    const first = new Connection();
    const second = new Connection();
    const signal = new AbortController().signal;
    (await pool.acquire(identity, () => first, signal))?.release(true);
    (await pool.acquire({ ...identity, modelId: 'other' }, () => second, signal))?.release(true);
    pool.retireModel(identity.ownerId, identity.provider, identity.modelId);
    assert.equal(first.closeCalls, 1);
    assert.equal(second.closeCalls, 0);
    const disposal = pool.dispose();
    first.confirmClose();
    second.confirmClose();
    await disposal;
});
