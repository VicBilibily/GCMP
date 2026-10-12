import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 写盘权限门闩。
 * 默认遵循外部注入的 canWrite 判定；在明确需要本地兜底时，可临时提升为允许写盘。
 */
export class WritePermissionGate {
    private canWriteEvaluator: () => boolean = () => true;
    private readonly forcedPermission = new AsyncLocalStorage<() => boolean>();

    setEvaluator(canWriteEvaluator: () => boolean): void {
        this.canWriteEvaluator = canWriteEvaluator;
    }

    canWrite(): boolean {
        return (this.forcedPermission.getStore() ?? this.canWriteEvaluator)();
    }

    async runWithForcedWrites<T>(operation: () => Promise<T>, canWrite: () => boolean = () => true): Promise<T> {
        return this.forcedPermission.run(canWrite, operation);
    }
}
