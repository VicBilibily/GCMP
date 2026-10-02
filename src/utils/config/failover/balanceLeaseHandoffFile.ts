import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import type { ApiKeyBalanceLeaseHandoff } from '../../../interInstance/eventProtocol';
import { resolveBalanceHandoffDirectory } from '../../../interInstance/pathResolver';
import { AtomicJsonFile } from '../../../usages/atomicJsonFile';

export const BALANCE_LEASE_TTL_MS = 30_000;
export const BALANCE_HANDOFF_TTL_MS = 30_000;
export const BALANCE_HANDOFF_MAX_LEASES = 1000;
const MAX_HANDOFF_FILE_BYTES = 2 * 1024 * 1024;

export function isValidBalanceLeaseHandoff(value: unknown): value is ApiKeyBalanceLeaseHandoff {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const handoff = value as ApiKeyBalanceLeaseHandoff;
    if (
        typeof handoff.sourceAuthorityTerm !== 'string' ||
        handoff.sourceAuthorityTerm.length === 0 ||
        handoff.sourceAuthorityTerm.length > 256 ||
        !Number.isFinite(handoff.capturedAt) ||
        !Array.isArray(handoff.leases) ||
        handoff.leases.length > BALANCE_HANDOFF_MAX_LEASES
    ) {
        return false;
    }
    const leaseIds = new Set<string>();
    return handoff.leases.every(lease => {
        if (
            !lease ||
            Array.isArray(lease) ||
            typeof lease.leaseId !== 'string' ||
            lease.leaseId.length === 0 ||
            lease.leaseId.length > 128 ||
            leaseIds.has(lease.leaseId) ||
            typeof lease.slot !== 'string' ||
            lease.slot.length === 0 ||
            lease.slot.length > 128 ||
            typeof lease.balanceKey !== 'string' ||
            lease.balanceKey.length === 0 ||
            lease.balanceKey.length > 1024 ||
            typeof lease.configId !== 'string' ||
            lease.configId.length === 0 ||
            lease.configId.length > 128 ||
            typeof lease.credentialId !== 'string' ||
            lease.credentialId.length === 0 ||
            lease.credentialId.length > 256 ||
            (lease.site !== undefined && (typeof lease.site !== 'string' || lease.site.length > 256)) ||
            typeof lease.ownerInstanceId !== 'string' ||
            lease.ownerInstanceId.length === 0 ||
            lease.ownerInstanceId.length > 128 ||
            !Number.isFinite(lease.expiresAt) ||
            lease.expiresAt > handoff.capturedAt + BALANCE_LEASE_TTL_MS + 1_000
        ) {
            return false;
        }
        leaseIds.add(lease.leaseId);
        return true;
    });
}

function fileName(authorityTerm: string): string {
    return `${createHash('sha256').update(authorityTerm).digest('hex')}.json`;
}

async function readSnapshot(filePath: string): Promise<ApiKeyBalanceLeaseHandoff | undefined> {
    let file: fs.FileHandle | undefined;
    try {
        file = await fs.open(filePath, 'r');
        if ((await file.stat()).size > MAX_HANDOFF_FILE_BYTES) {
            return undefined;
        }
        const value: unknown = JSON.parse(await file.readFile('utf8'));
        return isValidBalanceLeaseHandoff(value) ? value : undefined;
    } catch (error) {
        if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    } finally {
        await file?.close();
    }
}

function electedAt(handoff: ApiKeyBalanceLeaseHandoff): number {
    const suffix = handoff.sourceAuthorityTerm.slice(handoff.sourceAuthorityTerm.lastIndexOf(':') + 1);
    const value = Number(suffix);
    return Number.isSafeInteger(value) && value > 0 ? value : handoff.capturedAt;
}

export function isBalanceLeaseHandoffNewer(
    candidate: ApiKeyBalanceLeaseHandoff,
    previous: ApiKeyBalanceLeaseHandoff
): boolean {
    if (candidate.sourceAuthorityTerm === previous.sourceAuthorityTerm) {
        return candidate.capturedAt > previous.capturedAt;
    }
    const candidateTime = electedAt(candidate);
    const previousTime = electedAt(previous);
    return (
        candidateTime > previousTime ||
        (candidateTime === previousTime && candidate.sourceAuthorityTerm > previous.sourceAuthorityTerm)
    );
}

export async function writeBalanceLeaseHandoff(
    handoff: ApiKeyBalanceLeaseHandoff,
    directory = resolveBalanceHandoffDirectory()
): Promise<void> {
    if (!isValidBalanceLeaseHandoff(handoff)) {
        throw new Error('Invalid balance lease handoff');
    }
    const serialized = JSON.stringify({
        sourceAuthorityTerm: handoff.sourceAuthorityTerm,
        capturedAt: handoff.capturedAt,
        leases: handoff.leases.map(lease => ({
            leaseId: lease.leaseId,
            slot: lease.slot,
            balanceKey: lease.balanceKey,
            configId: lease.configId,
            credentialId: lease.credentialId,
            site: lease.site,
            ownerInstanceId: lease.ownerInstanceId,
            expiresAt: lease.expiresAt
        }))
    });
    if (Buffer.byteLength(serialized, 'utf8') > MAX_HANDOFF_FILE_BYTES) {
        throw new Error('Balance lease handoff exceeds the file size limit');
    }
    const filePath = join(directory, fileName(handoff.sourceAuthorityTerm));
    await AtomicJsonFile.runExclusive(filePath, async () => {
        const existing = await readSnapshot(filePath);
        if (existing && existing.capturedAt > handoff.capturedAt) {
            return;
        }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        await AtomicJsonFile.writeJsonAtomically(filePath, handoff, () => serialized);
    });
}

export async function readBalanceLeaseHandoff(
    directory = resolveBalanceHandoffDirectory(),
    now = Date.now()
): Promise<ApiKeyBalanceLeaseHandoff | undefined> {
    let entries: string[];
    try {
        entries = await fs.readdir(directory);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
        }
        throw error;
    }
    let latest: ApiKeyBalanceLeaseHandoff | undefined;
    const expiredFiles: Array<{ filePath: string; authorityTerm: string }> = [];
    for (const name of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) {
            continue;
        }
        const filePath = join(directory, name);
        const snapshot = await AtomicJsonFile.runExclusive(filePath, () => readSnapshot(filePath));
        if (!snapshot || fileName(snapshot.sourceAuthorityTerm) !== name) {
            continue;
        }
        const separator = snapshot.sourceAuthorityTerm.lastIndexOf(':');
        if (
            separator <= 0 ||
            separator === snapshot.sourceAuthorityTerm.length - 1 ||
            electedAt(snapshot) > snapshot.capturedAt + 1_000
        ) {
            continue;
        }
        if (snapshot.capturedAt - now > 1_000) {
            continue;
        }
        if (!latest || isBalanceLeaseHandoffNewer(snapshot, latest)) {
            latest = snapshot;
        }
        if (now - snapshot.capturedAt > BALANCE_HANDOFF_TTL_MS) {
            expiredFiles.push({ filePath, authorityTerm: snapshot.sourceAuthorityTerm });
        }
    }
    // 只清理已被更新任期替代的文件，避免读取旧内容后误删同任期的新快照。
    for (const expired of expiredFiles) {
        if (expired.authorityTerm !== latest?.sourceAuthorityTerm) {
            await fs.rm(expired.filePath, { force: true });
        }
    }
    // 读取不消费快照，未完成接管的实例不能让后续当选者丢失交接数据。
    return latest && now - latest.capturedAt <= BALANCE_HANDOFF_TTL_MS ? latest : undefined;
}
