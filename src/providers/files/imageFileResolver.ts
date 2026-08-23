/*---------------------------------------------------------------------------------------------
 *  图片 → Files API file_id 解析器
 *  进程内存缓存 + workspaceState 磁盘持久化（跨会话/重启复用），
 *  过期自动重新上传刷新，并发解析经 in-flight 去重。
 *
 *  存储说明：
 *  - workspaceState 为 VS Code Memento（按工作区隔离的 KV，落盘 state.vscdb，
 *    启动时整体水合进内存，update 防抖批量落盘，故 persistEntry 无需 await）。
 *  - 整个 Record<scopedKey, entry> 存于单 key（CACHE_KEY）：Memento 无键枚举 API，
 *    分 key 存储将无法清扫过期条目，单 map + 写时顺带清扫是更简单的取舍。
 *  - 每次持久化为整映射读-改-写（O(N) 写放大），但条目仅未过期时存活，
 *    N 受 TTL 窗口天然约束（真实场景几十~几百条，单条约 200B），无性能问题。
 *  - 查找键为 `{client.cacheScope}:{图片字节SHA-256前16hex}`：cacheScope 是上传
 *    目的地（uploadUrl+apiKey）的哈希指纹，不同 provider/账号/端点互不串用
 *    fileId；sessionId 仅记录首次上传会话，不参与查找，同目的地内相同图片跨会话复用。
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import type { FilesApiClient } from './filesApiClient';

interface CachedFileEntry {
    fileId: string;
    /** 首次上传所属会话 */
    sessionId: string;
    /** 创建时间（Unix 秒） */
    createdAt: number;
    /** 过期时间（Unix 秒，服务端 expires_at） */
    expiresAt: number;
}

const CACHE_KEY = 'gcmp.filesApi.cache';

export class ImageFileResolver {
    private readonly memory = new Map<string, CachedFileEntry>();
    private readonly inFlight = new Map<string, Promise<CachedFileEntry>>();

    constructor(
        private readonly client: FilesApiClient,
        private readonly workspaceState: vscode.Memento
    ) {}

    /**
     * 解析图片为 Files API file_id：命中未过期缓存则复用，过期或未上传则上传刷新。
     */
    async resolveFileId(bytes: Uint8Array, mimeType: string, ttlSeconds: number, sessionId: string): Promise<string> {
        const key = `${this.client.cacheScope}:${ImageFileResolver.hashBytes(bytes)}`;
        const now = Math.floor(Date.now() / 1000);

        const memHit = this.memory.get(key);
        if (memHit && memHit.expiresAt > now) {
            return memHit.fileId;
        }

        const inflight = this.inFlight.get(key);
        if (inflight) {
            return (await inflight).fileId;
        }

        const diskHit = this.readDiskEntry(key);
        if (diskHit && diskHit.expiresAt > now) {
            this.memory.set(key, diskHit);
            return diskHit.fileId;
        }

        const promise = this.uploadAndPersist(key, bytes, mimeType, ttlSeconds, sessionId);
        this.inFlight.set(key, promise);
        try {
            const entry = await promise;
            return entry.fileId;
        } finally {
            this.inFlight.delete(key);
        }
    }

    private async uploadAndPersist(
        key: string,
        bytes: Uint8Array,
        mimeType: string,
        ttlSeconds: number,
        sessionId: string
    ): Promise<CachedFileEntry> {
        const { fileId, expiresAt } = await this.client.uploadImage(bytes, mimeType, ttlSeconds);
        const entry: CachedFileEntry = { fileId, sessionId, createdAt: Math.floor(Date.now() / 1000), expiresAt };
        this.memory.set(key, entry);
        this.persistEntry(key, entry);
        return entry;
    }

    private readDiskEntry(key: string): CachedFileEntry | undefined {
        const cache = this.workspaceState.get<Record<string, CachedFileEntry>>(CACHE_KEY) ?? {};
        return cache[key];
    }

    private persistEntry(key: string, entry: CachedFileEntry): void {
        const cache = this.workspaceState.get<Record<string, CachedFileEntry>>(CACHE_KEY) ?? {};
        const now = Math.floor(Date.now() / 1000);
        // 顺带清理已过期与旧格式（无 scope 前缀）条目，控制磁盘膨胀
        for (const [k, v] of Object.entries(cache)) {
            if (v.expiresAt <= now || !k.includes(':')) {
                delete cache[k];
            }
        }
        cache[key] = entry;
        void this.workspaceState.update(CACHE_KEY, cache);
    }

    static hashBytes(bytes: Uint8Array): string {
        return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    }
}
