/**
 * 写盘权限门闩。
 * 默认遵循外部注入的 canWrite 判定；在明确需要本地兜底时，可临时提升为允许写盘。
 */
export class WritePermissionGate {
    private canWriteEvaluator: () => boolean = () => true;
    private forcedWriteDepth = 0;

    setEvaluator(canWriteEvaluator: () => boolean): void {
        this.canWriteEvaluator = canWriteEvaluator;
    }

    canWrite(): boolean {
        return this.forcedWriteDepth > 0 || this.canWriteEvaluator();
    }

    async runWithForcedWrites<T>(operation: () => Promise<T>): Promise<T> {
        this.forcedWriteDepth += 1;
        try {
            return await operation();
        } finally {
            this.forcedWriteDepth = Math.max(0, this.forcedWriteDepth - 1);
        }
    }
}