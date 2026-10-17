export interface RequestDiagnosticContext {
    requestId: string;
    sessionId: string;
    subSessionId?: string;
    attempt?: number;
    provider: string;
    modelId: string;
    sdkMode: string;
}

interface ErrorSummary {
    path: string;
    name?: string;
    code?: string;
    status?: number;
    message?: string;
}

export interface RequestDiagnosticEntry extends RequestDiagnosticContext {
    phase: string;
    at: number;
    elapsedMs: number;
    tokenCancelled: boolean;
    signalAborted?: boolean;
    hasReportedProgress: boolean;
    firstDataMs?: number;
    firstEventMs?: number;
    lastDataAgoMs?: number;
    firstErrorAt?: number;
    errors?: ErrorSummary[];
    cleanupErrors?: ErrorSummary[];
    source?: 'host_token' | 'stream_error' | 'terminal_cleanup' | 'finally_cleanup';
    outcome?: 'completed' | 'failed' | 'cancelled';
    retry?: boolean;
    reason?: string;
    responseStatus?: number;
    upstreamRequestId?: string;
    origin?: string;
    proxyMode?: 'direct' | 'configured' | 'system';
}

const SAFE_ERROR_MESSAGES = new Set([
    'terminated',
    'other side closed',
    'fetch failed',
    'socket hang up',
    'socket hangup',
    'connection error.',
    'request timed out.',
    'the operation was aborted.',
    'this operation was aborted'
]);

function diagnosticLabel(value: unknown): string | undefined {
    return typeof value === 'string' && /^[a-z\d_.:-]{1,96}$/i.test(value) && !/^sk-/i.test(value) ? value : undefined;
}

function summarizeError(error: unknown): ErrorSummary[] {
    const pending = [{ value: error, path: 'error' }];
    const visited = new Set<object>();
    const summaries: ErrorSummary[] = [];
    while (pending.length > 0 && summaries.length < 8) {
        const entry = pending.shift()!;
        if (!entry.value || typeof entry.value !== 'object' || visited.has(entry.value)) {
            continue;
        }
        visited.add(entry.value);
        const current = entry.value as Record<string, unknown>;
        const status = current.status ?? current.statusCode;
        summaries.push({
            path: entry.path,
            name: diagnosticLabel(current.name),
            code: diagnosticLabel(current.code),
            status: typeof status === 'number' && Number.isFinite(status) ? status : undefined,
            message:
                typeof current.message === 'string' && SAFE_ERROR_MESSAGES.has(current.message.toLowerCase()) ?
                    current.message
                :   undefined
        });
        pending.push({ value: current.cause, path: `${entry.path}.cause` });
        pending.push({ value: current.error, path: `${entry.path}.error` });
    }
    return summaries;
}

export class RequestDiagnostics {
    private readonly started = performance.now();
    private signal?: AbortSignal;
    private firstData?: number;
    private firstEvent?: number;
    private lastData?: number;
    private firstError?: { at: number; errors: ErrorSummary[] };
    private reportedProgress = false;
    private finished = false;
    private cleanupStarted = false;
    private cleanupErrorReported = false;

    constructor(
        private readonly context: RequestDiagnosticContext,
        private readonly write: (entry: RequestDiagnosticEntry) => void,
        private readonly state: () => { tokenCancelled: boolean; hasReportedProgress?: boolean }
    ) {
        this.emit('started');
    }

    bindSignal(signal: AbortSignal): void {
        this.signal = signal;
    }

    dispatched(url?: string | URL | Request, proxyUrl?: string): void {
        let origin: string | undefined;
        try {
            origin = new URL(
                typeof url === 'string' ? url
                : url instanceof URL ? url.href
                : (url?.url ?? '')
            ).origin;
        } catch {
            origin = undefined;
        }
        this.emit('dispatched', {
            origin,
            proxyMode:
                proxyUrl?.trim().toLowerCase() === 'noproxy' ? 'direct'
                : proxyUrl?.trim() ? 'configured'
                : 'system'
        });
    }

    headers(response: Response): void {
        this.emit('headers', {
            responseStatus: response.status,
            upstreamRequestId: diagnosticLabel(
                response.headers.get('x-request-id') ?? response.headers.get('request-id')
            )
        });
    }

    data(): void {
        const now = performance.now();
        this.lastData = now;
        if (this.firstData === undefined) {
            this.firstData = now;
            this.emit('first_data');
        }
    }

    streamEvent(): void {
        if (this.firstEvent === undefined) {
            this.firstEvent = performance.now();
            this.emit('first_event');
        }
    }

    progress(): void {
        if (!this.reportedProgress) {
            this.reportedProgress = true;
            this.emit('first_progress');
        }
    }

    error(error: unknown, transportError = false): void {
        if (!this.firstError) {
            let errors: ErrorSummary[];
            try {
                errors = summarizeError(error);
            } catch {
                errors = [];
            }
            if (this.cleanupStarted && transportError) {
                if (!this.cleanupErrorReported) {
                    this.cleanupErrorReported = true;
                    this.emit('cleanup_error', { cleanupErrors: errors });
                }
                return;
            }
            this.firstError = { at: Date.now(), errors };
            this.emit('error');
        }
    }

    abort(source: NonNullable<RequestDiagnosticEntry['source']>): void {
        if (source === 'terminal_cleanup' || source === 'finally_cleanup') {
            this.cleanupStarted = true;
        }
        this.emit('abort', { source });
    }

    decision(retry: boolean, reason: string): void {
        this.emit('retry_decision', { retry, reason });
    }

    finish(outcome: NonNullable<RequestDiagnosticEntry['outcome']>): void {
        this.emit('finished', { outcome });
        this.finished = true;
    }

    private emit(phase: string, fields: Partial<RequestDiagnosticEntry> = {}): void {
        if (this.finished) {
            return;
        }
        try {
            const now = performance.now();
            const state = this.state();
            this.write({
                ...this.context,
                phase,
                at: Date.now(),
                elapsedMs: now - this.started,
                tokenCancelled: state.tokenCancelled,
                signalAborted: this.signal?.aborted,
                hasReportedProgress: this.reportedProgress || state.hasReportedProgress === true,
                firstDataMs: this.firstData === undefined ? undefined : this.firstData - this.started,
                firstEventMs: this.firstEvent === undefined ? undefined : this.firstEvent - this.started,
                lastDataAgoMs: this.lastData === undefined ? undefined : now - this.lastData,
                firstErrorAt: this.firstError?.at,
                errors: this.firstError?.errors,
                ...fields
            });
        } catch {
            return;
        }
    }
}
