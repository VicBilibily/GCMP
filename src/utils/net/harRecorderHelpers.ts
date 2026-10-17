export interface HarFileRecord {
    name: string;
    path: string;
    mtime: number;
    pid: number;
}

export interface HarBodyData {
    text?: string;
    byteLength: number;
    aborted?: boolean;
}

const HAR_FILE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export function observeResponseBodyData(
    response: Response,
    signal?: AbortSignal,
    requestSignal?: AbortSignal
): { response: Response; body: Promise<HarBodyData> } {
    const source = response.body;
    if (!source) {
        return { response, body: Promise.resolve({ byteLength: 0 }) };
    }

    const chunks: Uint8Array[] = [];
    let totalLength = 0;
    let capturing = true;
    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let resolveBody!: (body: HarBodyData) => void;
    const body = new Promise<HarBodyData>(resolve => {
        resolveBody = resolve;
    });
    const signals = [signal, requestSignal].filter((value): value is AbortSignal => value !== undefined);
    const finishCapture = (aborted = false): void => {
        if (!capturing) {
            return;
        }
        capturing = false;
        for (const currentSignal of signals) {
            currentSignal.removeEventListener('abort', stopCapture);
        }
        try {
            const buffer = Buffer.concat(chunks, totalLength);
            resolveBody({
                text: buffer.toString('utf8'),
                byteLength: buffer.length,
                ...(aborted ? { aborted: true } : {})
            });
        } catch {
            resolveBody({ byteLength: 0, aborted: true });
        }
        chunks.length = 0;
    };
    const stopCapture = (): void => finishCapture(true);
    const stream = new ReadableStream<Uint8Array>(
        {
            async pull(controller) {
                try {
                    reader ??= source.getReader();
                    const { done, value } = await reader.read();
                    if (cancelled) {
                        return;
                    }
                    if (done) {
                        finishCapture();
                        reader.releaseLock();
                        controller.close();
                        return;
                    }
                    if (capturing) {
                        try {
                            chunks.push(Buffer.from(value));
                            totalLength += value.byteLength;
                        } catch {
                            finishCapture(true);
                        }
                    }
                    controller.enqueue(value);
                } catch (error) {
                    finishCapture();
                    reader?.releaseLock();
                    if (!cancelled) {
                        controller.error(error);
                    }
                }
            },
            cancel(reason) {
                cancelled = true;
                finishCapture(true);
                void (reader ? reader.cancel(reason) : source.cancel(reason)).catch(() => undefined);
                reader?.releaseLock();
            }
        },
        { highWaterMark: 0 }
    );
    const preserveMetadata = (wrapped: Response): Response => {
        const clone = wrapped.clone.bind(wrapped);
        Object.defineProperties(wrapped, {
            url: { value: response.url, configurable: true },
            redirected: { value: response.redirected, configurable: true },
            type: { value: response.type, configurable: true },
            clone: { value: () => preserveMetadata(clone()), configurable: true }
        });
        return wrapped;
    };
    const wrapped = preserveMetadata(
        new Response(stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        })
    );
    for (const currentSignal of signals) {
        currentSignal.addEventListener('abort', stopCapture, { once: true });
    }
    if (signals.some(currentSignal => currentSignal.aborted)) {
        stopCapture();
    }
    return { response: wrapped, body };
}

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

/**
 * 返回当前时刻的微秒级 epoch 时间戳（16 位整数）。
 *
 * 用于 HAR 的 `_startTimestamp` / `_endTimestamp` 自定义字段（下划线前缀符合 HAR 1.2 custom fields 规范），
 * 与 Reqable 等工具采用的微秒级时间戳格式对齐，便于跨工具对齐事件时序。
 *
 * 实现说明：`performance.timeOrigin`（进程启动时刻的毫秒级 epoch）+ `performance.now()`（高精度相对毫秒），
 * 再乘以 1000 取整即得微秒级绝对时间戳，避免 `Date.now()` 毫秒精度不足的问题。
 */
export function nowMicros(): number {
    return Math.floor((performance.timeOrigin + performance.now()) * 1000);
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

/**
 * 从 HAR 文件记录列表中选择当前 PID 最近修改的一个文件。
 * 仅返回属于 `currentPid` 的文件；当前 PID 无任何文件时返回 undefined（由调用方决定下一步兜底），
 * 避免跨进程串味、错误定位到其他实例的记录。
 */
export function pickLatestHarFile(files: readonly HarFileRecord[], currentPid: number): HarFileRecord | undefined {
    let latest: HarFileRecord | undefined;
    for (const file of files) {
        if (file.pid !== currentPid) {
            continue;
        }
        if (!latest || file.mtime > latest.mtime) {
            latest = file;
        }
    }
    return latest;
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
