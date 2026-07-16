export interface HarFileRecord {
    name: string;
    path: string;
    mtime: number;
    pid: number;
}

export interface HarBodyData {
    text?: string;
    byteLength: number;
}

const HAR_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

async function readStreamBodyData(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<HarBodyData> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    let stopRequested = signal?.aborted === true;
    const handleAbort = () => {
        stopRequested = true;
        void reader.cancel().catch(() => undefined);
    };

    if (signal) {
        signal.addEventListener('abort', handleAbort, { once: true });
    }

    try {
        while (!stopRequested) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value) {
                chunks.push(value);
                totalLength += value.length;
            }
        }
    } catch {
        if (!stopRequested) {
            // 非 abort 导致的异常（如连接中断），保留已读取的前缀
            const buffer = Buffer.concat(chunks, totalLength);
            return { text: buffer.toString('utf8'), byteLength: buffer.length };
        }
    } finally {
        if (signal) {
            signal.removeEventListener('abort', handleAbort);
        }
        try {
            await reader.cancel();
        } catch {
            // ignore
        }
    }

    const buffer = Buffer.concat(chunks, totalLength);
    return { text: buffer.toString('utf8'), byteLength: buffer.length };
}

export function formatLocalDateTime(date: Date): string {
    const pad = (value: number, length = 2) => value.toString().padStart(length, '0');
    return `${formatLocalDate(date)}T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}

export function formatLocalDate(date: Date): string {
    const pad = (value: number) => value.toString().padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function shouldRotateHarFileForDayChange(fileDayKey: string, now: Date, accepting: boolean): boolean {
    return accepting && fileDayKey !== formatLocalDate(now);
}

export function shouldRotateHarFileForAge(
    fileCreatedAt: number,
    now: number,
    intervalMs: number,
    accepting: boolean
): boolean {
    return accepting && now - fileCreatedAt >= intervalMs;
}

export function buildHarFileName(date: Date, pid: number, counter: number): string {
    return `gcmp_${formatLocalDateTime(date)}_${pid}_${counter}.har`;
}

export function calculateHarCompression(contentSize: number, transferSize: number): number | undefined {
    const compression = contentSize - transferSize;
    return compression > 0 ? compression : undefined;
}

export function parseHarPidFromFileName(name: string, fallbackPid: number): number {
    const pidMatch = name.match(/_(\d+)_(\d+)\.har$/) || name.match(/_(\d+)\.har$/);
    return pidMatch ? Number.parseInt(pidMatch[1], 10) : fallbackPid;
}

export function planHarCleanup(
    files: HarFileRecord[],
    retentionCount: number,
    now = Date.now(),
    currentPid?: number,
    reserveSlotsForCurrentPid = 0
): string[] {
    const removed = new Set<string>();
    const deletePaths: string[] = [];
    const markDeleted = (file: HarFileRecord): void => {
        if (removed.has(file.path)) {
            return;
        }
        removed.add(file.path);
        deletePaths.push(file.path);
    };

    const staleCutoff = now - HAR_FILE_MAX_AGE_MS;
    for (const file of files) {
        if (file.mtime < staleCutoff) {
            markDeleted(file);
        }
    }

    if (retentionCount <= 0) {
        return deletePaths;
    }

    const remainingAfterStale = files.filter(file => !removed.has(file.path));
    const byPid = new Map<number, HarFileRecord[]>();
    for (const file of remainingAfterStale) {
        const list = byPid.get(file.pid) ?? [];
        list.push(file);
        byPid.set(file.pid, list);
    }

    for (const [, list] of byPid) {
        list.sort((a, b) => b.mtime - a.mtime);
        const limit =
            currentPid !== undefined && list[0]?.pid === currentPid ?
                Math.max(retentionCount - reserveSlotsForCurrentPid, 0)
            :   retentionCount;
        for (let i = limit; i < list.length; i++) {
            markDeleted(list[i]);
        }
    }

    return deletePaths;
}

export async function readBodyData(body: BodyInit | undefined | null, signal?: AbortSignal): Promise<HarBodyData> {
    if (body === undefined || body === null) {
        return { byteLength: 0 };
    }

    if (typeof body === 'string') {
        return { text: body, byteLength: Buffer.byteLength(body, 'utf8') };
    }

    if (Buffer.isBuffer(body)) {
        const text = body.toString('utf8');
        return { text, byteLength: body.length };
    }

    if (body instanceof Uint8Array) {
        const buffer = Buffer.from(body);
        return { text: buffer.toString('utf8'), byteLength: body.byteLength };
    }

    if (body instanceof ArrayBuffer) {
        const buffer = Buffer.from(body);
        return { text: buffer.toString('utf8'), byteLength: buffer.length };
    }

    if (body instanceof Blob) {
        const arrayBuffer = await body.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return { text: buffer.toString('utf8'), byteLength: buffer.length };
    }

    if (body instanceof URLSearchParams) {
        const text = body.toString();
        return { text, byteLength: Buffer.byteLength(text, 'utf8') };
    }

    if (body instanceof ReadableStream) {
        return readStreamBodyData(body, signal);
    }

    if (body instanceof FormData) {
        try {
            const serialized = await new Response(body).arrayBuffer();
            const buffer = Buffer.from(serialized);
            return { text: buffer.toString('utf8'), byteLength: buffer.length };
        } catch {
            return { byteLength: 0 };
        }
    }

    return { byteLength: 0 };
}

export async function readResponseBodyData(response: Response, signal?: AbortSignal): Promise<HarBodyData> {
    try {
        if (!response.body) {
            return { byteLength: 0 };
        }
        return await readStreamBodyData(response.body, signal);
    } catch {
        return { byteLength: 0 };
    }
}
