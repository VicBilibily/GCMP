import { Logger } from '../../../utils/runtime/logger';

export function runStreamCleanup(steps: readonly (() => void)[], preservePrimaryError: boolean): void {
    let failed = false;
    let firstError: unknown;
    for (const step of steps) {
        try {
            step();
        } catch (error) {
            if (!failed) {
                firstError = error;
                failed = true;
            }
            try {
                Logger.warn('[OpenAI] Stream cleanup failed', error);
            } catch {
                continue;
            }
        }
    }
    if (failed && !preservePrimaryError) {
        throw firstError;
    }
}
