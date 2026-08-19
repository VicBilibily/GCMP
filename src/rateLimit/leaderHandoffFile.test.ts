import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

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
