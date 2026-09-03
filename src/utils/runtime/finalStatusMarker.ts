export interface FinalStatusRecordedError extends Error {
    gcmpFinalStatusRecorded?: true;
}

export function markFinalStatusRecorded(error: unknown): void {
    if (error instanceof Error) {
        (error as FinalStatusRecordedError).gcmpFinalStatusRecorded = true;
    }
}

export function copyFinalStatusRecorded(source: unknown, target: unknown): void {
    if (source instanceof Error && (source as FinalStatusRecordedError).gcmpFinalStatusRecorded) {
        markFinalStatusRecorded(target);
    }
}

export function hasFinalStatusRecorded(error: unknown): boolean {
    return error instanceof Error && (error as FinalStatusRecordedError).gcmpFinalStatusRecorded === true;
}
