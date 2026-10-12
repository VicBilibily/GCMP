import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext } from 'node:test';
import type { TokenRequestLog } from '../../../fileLogger/types';

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
export const promises = require('node:fs/promises') as typeof fs;
export function record(requestId: string): TokenRequestLog {
    return {
        requestId,
        timestamp: Date.now(),
        isoTime: new Date().toISOString(),
        providerKey: 'test',
        providerName: 'Test',
        modelId: 'test',
        modelName: 'Test',
        estimatedInput: 1,
        rawUsage: null,
        status: 'completed'
    };
}
export function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => {
        release = resolve;
    });
    return { promise, release };
}
export async function bounded<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('snapshot boundary not reached')), 6000);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}
export async function loadSnapshot() {
    const original = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return { window: {}, env: { language: 'zh-cn' } };
        }
        return original.call(this, id);
    };
    const { SnapshotManager } = await import('../../../fileLogger/snapshotManager');
    const { LogPathManager } = await import('../../../fileLogger/logPathManager');
    const { DateUtils } = await import('../../../fileLogger/dateUtils');
    const { parseSnapshotFileContent } = await import('../../../fileLogger/snapshotMerge');
    return {
        SnapshotManager,
        LogPathManager,
        DateUtils,
        parseSnapshotFileContent,
        restore: () => {
            NodeModule.prototype.require = original;
        }
    };
}
export async function fixture(context: TestContext) {
    const modules = await loadSnapshot();
    const dir = await fs.mkdtemp(join(tmpdir(), 'gcmp-snapshot-lock-'));
    const constants = modules.SnapshotManager as unknown as {
        SNAPSHOT_LOCK_WAIT_MS: number;
        SNAPSHOT_LOCK_RETRY_MS: number;
    };
    const waitMs = constants.SNAPSHOT_LOCK_WAIT_MS,
        retryMs = constants.SNAPSHOT_LOCK_RETRY_MS;
    constants.SNAPSHOT_LOCK_WAIT_MS = 2000;
    constants.SNAPSHOT_LOCK_RETRY_MS = 5;
    context.after(async () => {
        constants.SNAPSHOT_LOCK_WAIT_MS = waitMs;
        constants.SNAPSHOT_LOCK_RETRY_MS = retryMs;
        modules.restore();
        await fs.rm(dir, { recursive: true, force: true });
    });
    const paths = new modules.LogPathManager(dir),
        date = modules.DateUtils.getDateStringDaysAgo(3);
    const snapshot = new modules.SnapshotManager(paths, () => {});
    const path = paths.getSnapshotFilePath(date),
        lock = join(paths.getDateFolderPath(date), '.requests.lock');
    const ownerPath = join(lock, 'owner.json'),
        guard = `${lock}.reclaim`;
    await snapshot.upsertRecord(date, record('base'));
    const child = spawnSync(process.execPath, ['-e', ''], { stdio: 'ignore' });
    assert.equal(child.status, 0);
    assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
    const dead = { pid: child.pid, token: randomUUID() };
    const ids = async () => Object.keys(modules.parseSnapshotFileContent(await fs.readFile(path, 'utf8'))).sort();
    return { ...modules, dir, paths, date, snapshot, path, lock, ownerPath, guard, dead, constants, ids };
}
export async function seedOwner(
    f: Awaited<ReturnType<typeof fixture>>,
    owner: { pid: number; token: string } = f.dead
): Promise<string> {
    const content = JSON.stringify(owner);
    await fs.mkdir(f.lock);
    await fs.writeFile(f.ownerPath, content);
    return content;
}
