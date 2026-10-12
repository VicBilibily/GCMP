import assert from 'node:assert/strict';
import test from 'node:test';

import { WritePermissionGate } from './writePermissionGate';

test('gate follows external evaluator by default', () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    assert.equal(gate.canWrite(), false);
});

test('runWithForcedWrites temporarily bypasses external evaluator', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    let observedInside = false;
    await gate.runWithForcedWrites(async () => {
        observedInside = gate.canWrite();
    });

    assert.equal(observedInside, true);
    assert.equal(gate.canWrite(), false);
});

test('nested forced-write scopes restore previous state correctly', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);

    let outer = false;
    let inner = false;
    await gate.runWithForcedWrites(async () => {
        outer = gate.canWrite();
        await gate.runWithForcedWrites(async () => {
            inner = gate.canWrite();
        });
        assert.equal(gate.canWrite(), true);
    });

    assert.equal(outer, true);
    assert.equal(inner, true);
    assert.equal(gate.canWrite(), false);
});

test('forced permission follows its live fallback predicate', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);
    const run = gate.runWithForcedWrites.bind(gate) as <T>(
        operation: () => Promise<T>,
        permitted: () => boolean
    ) => Promise<T>;
    let permitted = true;
    await run(
        async () => {
            assert.equal(gate.canWrite(), true);
            permitted = false;
            await Promise.resolve();
            assert.equal(gate.canWrite(), false);
        },
        () => permitted
    );
    assert.equal(gate.canWrite(), false);
});

test('an unrelated async request cannot borrow an in-flight forced write scope', async () => {
    const gate = new WritePermissionGate();
    gate.setEvaluator(() => false);
    let release!: () => void;
    const blocked = new Promise<void>(resolve => {
        release = resolve;
    });
    const work = gate.runWithForcedWrites(async () => {
        assert.equal(gate.canWrite(), true);
        await blocked;
        assert.equal(gate.canWrite(), true);
    });
    try {
        await Promise.resolve();
        assert.equal(gate.canWrite(), false);
    } finally {
        release();
        await work;
    }
    assert.equal(gate.canWrite(), false);
});
