interface PendingRelease {
    release: () => Promise<void>;
    delay: number;
    task?: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
}

const pendingReleases = new Map<string, PendingRelease>();

function finishRelease(lockPath: string, pending: PendingRelease): Promise<void> {
    if (pending.task) {
        return pending.task;
    }
    clearTimeout(pending.timer);
    pending.timer = undefined;
    const task = (async () => {
        await pending.release();
        if (pendingReleases.get(lockPath) === pending) {
            pendingReleases.delete(lockPath);
        }
    })();
    pending.task = task;
    void task.then(
        () => {
            pending.task = undefined;
        },
        () => {
            pending.task = undefined;
            pending.timer = setTimeout(() => {
                pending.timer = undefined;
                void finishRelease(lockPath, pending).catch(() => undefined);
            }, pending.delay);
            pending.delay = Math.min(pending.delay * 2, 1000);
            pending.timer.unref();
        }
    );
    return task;
}

export async function finishPendingRelease(lockPath: string): Promise<void> {
    const pending = pendingReleases.get(lockPath);
    if (pending) {
        await finishRelease(lockPath, pending);
    }
}

export function releaseLock(lockPath: string, release: () => Promise<void>): Promise<void> {
    const pending: PendingRelease = { release, delay: 25 };
    pendingReleases.set(lockPath, pending);
    return finishRelease(lockPath, pending);
}

export async function withLockCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
    let result: { value: T } | { error: unknown };
    try {
        result = { value: await operation() };
    } catch (error) {
        result = { error };
    }
    try {
        await cleanup();
    } catch (error) {
        if ('error' in result) {
            const primary = result.error;
            const detail = primary instanceof Error ? `: ${primary.message}` : '';
            const cause = primary instanceof Error ? (primary.cause ?? primary) : primary;
            throw new AggregateError([primary, error], `Lock operation and cleanup both failed${detail}`, { cause });
        }
        throw error;
    }
    if ('error' in result) {
        throw result.error;
    }
    return result.value;
}
