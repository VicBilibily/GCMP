import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { LeaderFilePublisher, readLeaderFile, writeLeaderFile } from './leaderFile';
import { AtomicJsonFile } from '../usages/atomicJsonFile';

function tempFilePath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcmp-leaderfile-test-'));
    return path.join(dir, 'leader.json');
}

test('readLeaderFile returns undefined when file does not exist', () => {
    assert.equal(readLeaderFile(tempFilePath()), undefined);
});

test('writeLeaderFile then readLeaderFile round-trips leader info', async () => {
    const filePath = tempFilePath();
    const info = {
        instanceId: 'inst-1',
        authorityTerm: 'inst-1:123',
        ipcPath: '\\\\.\\pipe\\gcmp-test',
        updatedAt: 123
    };

    await writeLeaderFile(info, filePath);

    assert.deepEqual(readLeaderFile(filePath), info);
});

test('writeLeaderFile replaces an existing file that is temporarily open', async () => {
    const filePath = tempFilePath();
    const info = { instanceId: 'inst-1', authorityTerm: 'inst-1:1', ipcPath: 'p1', updatedAt: 1 };
    await writeLeaderFile(info, filePath);

    // 模拟 Agents 窗体短促读取：首次 rename 可能因 Windows 句柄占用触发 EPERM，
    // 释放句柄后写入应通过退避重试完成，而不是静默保留旧 Leader。
    const readHandle = await fs.promises.open(filePath, 'r');
    const writePromise = writeLeaderFile(
        { instanceId: 'inst-2', authorityTerm: 'inst-2:2', ipcPath: 'p2', updatedAt: 2 },
        filePath
    );
    await new Promise(resolve => setTimeout(resolve, 40));
    await readHandle.close();
    await writePromise;

    assert.deepEqual(readLeaderFile(filePath), {
        instanceId: 'inst-2',
        authorityTerm: 'inst-2:2',
        ipcPath: 'p2',
        updatedAt: 2
    });
});

test('readLeaderFile returns undefined for corrupted content', async () => {
    const filePath = tempFilePath();
    fs.writeFileSync(filePath, 'not-json', 'utf8');
    assert.equal(readLeaderFile(filePath), undefined);

    fs.writeFileSync(filePath, '{"ipcPath":1}', 'utf8');
    assert.equal(readLeaderFile(filePath), undefined);
});

test('a new leader atomically replaces the previous leader record', async () => {
    const filePath = tempFilePath();
    await writeLeaderFile({ instanceId: 'inst-1', authorityTerm: 'inst-1:1', ipcPath: 'p1', updatedAt: 1 }, filePath);

    await writeLeaderFile({ instanceId: 'inst-2', authorityTerm: 'inst-2:2', ipcPath: 'p2', updatedAt: 2 }, filePath);

    assert.deepEqual(readLeaderFile(filePath), {
        instanceId: 'inst-2',
        authorityTerm: 'inst-2:2',
        ipcPath: 'p2',
        updatedAt: 2
    });
});

test('leader publisher restores the current leader after a stale overwrite', async () => {
    const filePath = tempFilePath();
    const publisher = new LeaderFilePublisher('current', 'current:1', 'current-pipe', filePath, 500);
    await publisher.start();

    try {
        // 模拟旧 Leader 的 rename 重试迟到：当前 Leader 已发布后，旧记录才落盘。
        await writeLeaderFile(
            { instanceId: 'stale', authorityTerm: 'stale:1', ipcPath: 'stale-pipe', updatedAt: 1 },
            filePath
        );

        assert.equal(readLeaderFile(filePath)?.instanceId, 'stale');
        await waitFor(() => readLeaderFile(filePath)?.instanceId === 'current', 1000);
    } finally {
        await publisher.stop();
    }
});

test('leader publisher stops refreshing after stop', async () => {
    const filePath = tempFilePath();
    const publisher = new LeaderFilePublisher('current', 'current:1', 'current-pipe', filePath, 30);
    await publisher.start();
    await publisher.stop();

    await writeLeaderFile(
        { instanceId: 'next', authorityTerm: 'next:2', ipcPath: 'next-pipe', updatedAt: 2 },
        filePath
    );
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(readLeaderFile(filePath)?.instanceId, 'next');
});

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            assert.fail('condition was not met before timeout');
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test('publisher rejects a failed initial write and can be started again', async () => {
    const filePath = tempFilePath();
    const originalWrite = AtomicJsonFile.writeJsonAtomically;
    const publisher = new LeaderFilePublisher('current', 'current:2', 'pipe', filePath);
    await writeLeaderFile(
        { instanceId: 'current', authorityTerm: 'current:1', ipcPath: 'pipe', updatedAt: 1 },
        filePath
    );
    AtomicJsonFile.writeJsonAtomically = async () => {
        throw new Error('isolated initial publication failure');
    };
    try {
        await assert.rejects(publisher.start(), /Failed to publish leader file/);
        assert.equal(readLeaderFile(filePath)?.authorityTerm, 'current:1');
        await publisher.stop();
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        await publisher.start();
        assert.equal(readLeaderFile(filePath)?.authorityTerm, 'current:2');
    } finally {
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        await publisher.stop();
    }
});

test('periodic publication retries after a failed refresh', async () => {
    const filePath = tempFilePath();
    const originalWrite = AtomicJsonFile.writeJsonAtomically;
    const publisher = new LeaderFilePublisher('current', 'current:2', 'pipe', filePath, 20);
    let failed = false;
    await publisher.start();
    try {
        await writeLeaderFile(
            { instanceId: 'stale', authorityTerm: 'stale:1', ipcPath: 'old', updatedAt: 1 },
            filePath
        );
        AtomicJsonFile.writeJsonAtomically = async (...args) => {
            if (args[0] === filePath && !failed) {
                failed = true;
                throw new Error('isolated periodic publication failure');
            }
            await originalWrite.call(AtomicJsonFile, ...args);
        };
        await waitFor(() => failed && readLeaderFile(filePath)?.authorityTerm === 'current:2', 10_000);
    } finally {
        AtomicJsonFile.writeJsonAtomically = originalWrite;
        await publisher.stop();
    }
});
