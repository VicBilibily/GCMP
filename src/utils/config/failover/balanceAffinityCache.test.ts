import assert from 'node:assert/strict';
import test from 'node:test';
import { BalanceAffinityCache, getBalanceTurnKey } from './balanceAffinityCache';

test('stable turn keys distinguish sessions and turns without depending on prompt text', () => {
    assert.equal(getBalanceTurnKey('session', 0), 'm:session:turn:0');
    assert.equal(getBalanceTurnKey('session', 1), 'm:session:turn:1');
    assert.notEqual(getBalanceTurnKey('session', 1), getBalanceTurnKey('session', 2));
    assert.notEqual(getBalanceTurnKey('session', 1), getBalanceTurnKey('other', 1));
    assert.ok(getBalanceTurnKey('session', Number.MAX_SAFE_INTEGER));
});

for (const value of [undefined, null, '1', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, false, [], {}]) {
    test(`unreliable turn metadata does not produce a recovery key: ${String(value)}`, () => {
        assert.equal(getBalanceTurnKey('session', value), undefined);
    });
}

test('cached credential fingerprints are isolated by slot, session and turn', () => {
    const cache = new BalanceAffinityCache();
    const firstTurn = getBalanceTurnKey('session', 1)!;
    cache.remember('first', firstTurn, 'credential-a');
    cache.remember('second', firstTurn, 'credential-b');
    assert.equal(cache.get('first', firstTurn), 'credential-a');
    assert.equal(cache.get('second', firstTurn), 'credential-b');
    assert.equal(cache.get('first', getBalanceTurnKey('session', 2)!), undefined);
    assert.equal(cache.get('first', getBalanceTurnKey('other', 1)!), undefined);
});

test('slot and balance key delimiters cannot collide', () => {
    const cache = new BalanceAffinityCache();
    cache.remember('slot:unit', 'turn', 'credential-a');
    cache.remember('slot', 'unit:turn', 'credential-b');
    assert.equal(cache.get('slot:unit', 'turn'), 'credential-a');
    assert.equal(cache.get('slot', 'unit:turn'), 'credential-b');
});

test('replacement credentials overwrite the old binding', () => {
    const cache = new BalanceAffinityCache();
    cache.remember('slot', 'turn', 'old');
    cache.remember('slot', 'turn', 'replacement');
    assert.equal(cache.get('slot', 'turn'), 'replacement');
});

test('inactive bindings expire after the recovery lifetime', () => {
    let now = 0;
    const cache = new BalanceAffinityCache(() => now);
    cache.remember('slot', 'turn', 'credential');
    now = 7 * 24 * 60 * 60 * 1_000 - 1;
    assert.equal(cache.get('slot', 'turn'), 'credential');
    now++;
    assert.equal(cache.get('slot', 'turn'), undefined);
});

test('a new dispatch refreshes the binding lifetime', () => {
    let now = 0;
    const cache = new BalanceAffinityCache(() => now);
    cache.remember('slot', 'turn', 'credential');
    now = 1_000;
    cache.remember('slot', 'turn', 'replacement');
    now = 7 * 24 * 60 * 60 * 1_000;
    assert.equal(cache.get('slot', 'turn'), 'replacement');
    now += 1_000;
    assert.equal(cache.get('slot', 'turn'), undefined);
});

test('cache capacity evicts the oldest dispatch and retains refreshed bindings', () => {
    const cache = new BalanceAffinityCache();
    for (let index = 0; index < 1_000; index++) {
        cache.remember('slot', `turn-${index}`, `credential-${index}`);
    }
    cache.remember('slot', 'turn-0', 'refreshed');
    cache.remember('slot', 'turn-1000', 'latest');
    assert.equal(cache.get('slot', 'turn-0'), 'refreshed');
    assert.equal(cache.get('slot', 'turn-1'), undefined);
    assert.equal(cache.get('slot', 'turn-2'), 'credential-2');
    assert.equal(cache.get('slot', 'turn-1000'), 'latest');
});

test('mode changes clear only the selected slot', () => {
    const cache = new BalanceAffinityCache();
    cache.remember('slot', 'turn-1', 'a');
    cache.remember('slot', 'turn-2', 'b');
    cache.remember('slot-other', 'turn-1', 'c');
    cache.clear('slot');
    assert.equal(cache.get('slot', 'turn-1'), undefined);
    assert.equal(cache.get('slot', 'turn-2'), undefined);
    assert.equal(cache.get('slot-other', 'turn-1'), 'c');
    cache.clear();
    assert.equal(cache.get('slot-other', 'turn-1'), undefined);
});
