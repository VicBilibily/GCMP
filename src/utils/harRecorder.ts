import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from './logger';
import {
    buildHarFileName,
    calculateHarCompression,
    formatLocalDate,
    parseHarPidFromFileName,
    planHarCleanup,
    readBodyData,
    readResponseBodyData,
    shouldRotateHarFileForDayChange,
    type HarBodyData,
    type HarFileRecord
} from './harRecorderHelpers';

export interface HarRecorderOptions {
    /** 是否启用 HAR 记录 */
    enabled: boolean;
    /** 扩展版本号，写入 HAR creator */
    extensionVersion: string;
    /** 默认存储目录（通常为 context.globalStorageUri.fsPath） */
    defaultStoragePath: string;
    /** 保留的 HAR 文件数量 */
    retentionCount: number;
}

interface HarHeader {
    name: string;
    value: string;
}

interface HarCookie {
    name: string;
    value: string;
}

interface HarQueryString {
    name: string;
    value: string;
}

interface HarPostData {
    mimeType: string;
    text: string;
}

interface HarRequest {
    method: string;
    url: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: HarCookie[];
    queryString: HarQueryString[];
    postData?: HarPostData;
    headersSize: number;
    bodySize: number;
}

interface HarResponse {
    status: number;
    statusText: string;
    httpVersion: string;
    headers: HarHeader[];
    cookies: HarCookie[];
    content: {
        size: number;
        compression?: number;
        mimeType: string;
        text?: string;
    };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
}

interface HarEntry {
    startedDateTime: string;
    time: number;
    request: HarRequest;
    response: HarResponse;
    cache: Record<string, unknown>;
    timings: {
        blocked: number;
        dns: number;
        connect: number;
        send: number;
        wait: number;
        receive: number;
        ssl: number;
    };
}

interface HarRecorderState {
    options: HarRecorderOptions;
    storageDir: string;
    filePath: string;
    fileDayKey: string;
    entries: HarEntry[];
    flushTimer: NodeJS.Timeout | undefined;
    lastFlushTime: number;
    requestCount: number;
    accepting: boolean;
    activeCaptureTasks: Set<Promise<void>>;
    activeCaptureControllers: Set<AbortController>;
}

const sensitiveHeaderNamePattern =
    /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

const sensitiveFieldPattern = /(api[-_]?key|auth|authorization|token|session|cookie|secret|password|signature|nonce)$/i;

const maxBodySize = 1024 * 1024;

/**
 * HAR 请求记录器
 * 在统一的 fetch 出口处拦截请求与响应，生成符合 HAR 1.2 规范的记录文件。
 */
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_ENTRY_THRESHOLD = 10;
const MAX_BUFFERED_ENTRIES = 100;

export class HarRecorder {
    private static instance: HarRecorder | undefined;

    private currentState: HarRecorderState | undefined;
    private readonly closingStates = new Set<HarRecorderState>();
    private fileCounter = 0;
    private readonly MAX_REQUESTS_PER_FILE = 50;

    static getInstance(): HarRecorder {
        if (!HarRecorder.instance) {
            HarRecorder.instance = new HarRecorder();
        }
        return HarRecorder.instance;
    }

    /**
     * 初始化记录器。
     * 若配置发生变化（如开关、路径），会先关闭当前文件再按新配置重建。
     */
    initialize(options: HarRecorderOptions): void {
        const previousState = this.currentState;
        const needRestart =
            !previousState ||
            previousState.options.enabled !== options.enabled ||
            previousState.options.defaultStoragePath !== options.defaultStoragePath ||
            previousState.options.retentionCount !== options.retentionCount;

        if (!needRestart) {
            previousState.options = options;
            return;
        }

        if (previousState) {
            this.closeState(previousState);
            this.currentState = undefined;
        }

        if (!options.enabled) {
            return;
        }

        const now = new Date();
        const storageDir = path.join(options.defaultStoragePath, 'har');
        this.ensureDirectory(storageDir);
        const state: HarRecorderState = {
            options,
            storageDir,
            filePath: path.join(storageDir, this.generateFileName(now)),
            fileDayKey: formatLocalDate(now),
            entries: [],
            flushTimer: undefined,
            lastFlushTime: Date.now(),
            requestCount: 0,
            accepting: true,
            activeCaptureTasks: new Set<Promise<void>>(),
            activeCaptureControllers: new Set<AbortController>()
        };
        this.currentState = state;
        this.cleanupOldHarFiles(state.storageDir, options.retentionCount, 1);
        this.flush(state);
        this.startFlushTimer(state);
        Logger.info(`[HAR] Recording enabled, writing to ${state.filePath}`);
    }

    isEnabled(): boolean {
        return this.currentState?.options.enabled === true && this.currentState.accepting === true;
    }

    /**
     * 包装 fetch 实现，在请求完成后追加 HAR entry。
     * 响应体通过独立的后台读取路径采集，不影响原始 response 返回给调用方。
     */
    wrapFetch(fetchImpl: typeof fetch): typeof fetch {
        return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
            const state = this.currentState;
            if (!state || !state.accepting) {
                return fetchImpl(input, init);
            }

            const startedDateTime = new Date().toISOString();
            const startTime = performance.now();

            const fetchInput = input;
            let fetchInit = init;
            const captureInput = input instanceof Request ? input.url : input;
            let captureInit: RequestInit | undefined;
            let requestBodyPromise: Promise<HarBodyData> | undefined;
            let requestBodyController: AbortController | undefined;

            if (input instanceof Request) {
                if (input.body && init?.body === undefined) {
                    try {
                        const clonedRequestBody = input.clone().body ?? undefined;
                        if (clonedRequestBody) {
                            captureInit = {
                                method: input.method,
                                headers: input.headers,
                                mode: input.mode,
                                credentials: input.credentials,
                                cache: input.cache,
                                redirect: input.redirect,
                                referrer: input.referrer,
                                referrerPolicy: input.referrerPolicy,
                                integrity: input.integrity,
                                keepalive: input.keepalive,
                                signal: input.signal,
                                ...init,
                                body: clonedRequestBody
                            };
                        }
                    } catch (error) {
                        Logger.warn('[HAR] Failed to clone Request body for capture', error);
                    }
                }

                captureInit = captureInit ?? {
                    method: input.method,
                    headers: input.headers,
                    mode: input.mode,
                    credentials: input.credentials,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    referrerPolicy: input.referrerPolicy,
                    integrity: input.integrity,
                    keepalive: input.keepalive,
                    signal: input.signal,
                    ...init
                };
            } else {
                captureInit = fetchInit ? { ...fetchInit } : undefined;
            }

            if (fetchInit?.body instanceof ReadableStream) {
                try {
                    const [bodyForFetch, bodyForCapture] = fetchInit.body.tee();
                    fetchInit = { ...fetchInit, body: bodyForFetch };
                    captureInit = { ...(captureInit ?? {}), body: bodyForCapture };
                } catch (error) {
                    Logger.warn('[HAR] Failed to tee request body stream for capture', error);
                    captureInit = { ...(captureInit ?? {}), body: undefined };
                }
            }

            if (captureInit?.body !== undefined && captureInit.body !== null) {
                requestBodyController = new AbortController();
                requestBodyPromise = this.readRequestBody(captureInit.body, requestBodyController.signal).catch(
                    error => {
                        Logger.warn('[HAR] Failed to read request body for capture', error);
                        return { byteLength: 0 };
                    }
                );
                this.startCaptureTask(
                    state,
                    requestBodyPromise.then(() => undefined),
                    requestBodyController
                );
            }

            let response: Response;
            try {
                response = await fetchImpl(fetchInput, fetchInit);
            } catch (error) {
                if (!state.accepting) {
                    throw error;
                }
                const endTime = performance.now();
                this.startCaptureTask(
                    state,
                    this.captureErrorEntry(
                        state,
                        captureInput,
                        captureInit,
                        requestBodyPromise,
                        error,
                        startedDateTime,
                        startTime,
                        endTime
                    )
                );
                throw error;
            }

            if (!state.accepting) {
                return response;
            }

            if (!response.body) {
                this.startCaptureTask(
                    state,
                    this.captureEntry(
                        state,
                        captureInput,
                        captureInit,
                        response,
                        startedDateTime,
                        startTime,
                        requestBodyPromise,
                        {
                            text: '',
                            byteLength: 0
                        }
                    )
                );
                return response;
            }

            const captureController = new AbortController();
            this.startCaptureTask(
                state,
                this.captureEntry(
                    state,
                    captureInput,
                    captureInit,
                    response.clone(),
                    startedDateTime,
                    startTime,
                    requestBodyPromise,
                    undefined,
                    captureController.signal
                ),
                captureController
            );
            return response;
        };
    }

    private async captureErrorEntry(
        state: HarRecorderState,
        input: string | URL | Request,
        init: RequestInit | undefined,
        requestBodyPromise: Promise<HarBodyData> | undefined,
        error: unknown,
        startedDateTime: string,
        startTime: number,
        endTime: number
    ): Promise<void> {
        try {
            const url =
                typeof input === 'string' ? input
                : input instanceof URL ? input.href
                : input.url;
            const method = init?.method || (input instanceof Request ? input.method : 'GET');
            const requestHeaders = this.headersToRecord(
                init?.headers || (input instanceof Request ? input.headers : undefined)
            );
            const requestContentType = this.getContentType(requestHeaders) || this.inferRequestContentType(init?.body);
            const requestBody = await (requestBodyPromise ?? Promise.resolve<HarBodyData>({ byteLength: 0 }));

            const errorMessage = error instanceof Error ? error.message : String(error);

            const entry: HarEntry = {
                startedDateTime,
                time: Math.round(endTime - startTime),
                request: {
                    method,
                    url: this.sanitizeUrl(url),
                    httpVersion: 'HTTP/1.1',
                    headers: this.sanitizeHeaders(requestHeaders),
                    cookies: [],
                    queryString: this.parseQueryString(url),
                    postData:
                        requestBody.text !== undefined ?
                            {
                                mimeType: requestContentType || 'application/octet-stream',
                                text: requestBody.text
                            }
                        :   undefined,
                    headersSize: this.estimateHeadersSize(method, url, requestHeaders),
                    bodySize: requestBody.byteLength
                },
                response: {
                    status: 0,
                    statusText: errorMessage,
                    httpVersion: '',
                    headers: [],
                    cookies: [],
                    content: {
                        size: 0,
                        mimeType: 'text/plain',
                        text: errorMessage
                    },
                    redirectURL: '',
                    headersSize: 0,
                    bodySize: -1
                },
                cache: {},
                timings: {
                    blocked: -1,
                    dns: -1,
                    connect: -1,
                    send: 0,
                    wait: Math.round(endTime - startTime),
                    receive: 0,
                    ssl: -1
                }
            };
            this.enqueueEntry(state, entry);
        } catch (captureError) {
            Logger.warn('[HAR] Failed to capture error entry', captureError);
        }
    }

    private async captureEntry(
        state: HarRecorderState,
        input: string | URL | Request,
        init: RequestInit | undefined,
        response: Response,
        startedDateTime: string,
        startTime: number,
        requestBodyPromise: Promise<HarBodyData> | undefined,
        responseBody?: HarBodyData,
        signal?: AbortSignal
    ): Promise<void> {
        try {
            const responseBodyPromise =
                responseBody ? Promise.resolve(responseBody) : this.readResponseBody(response, signal);
            const [requestBody, resolvedResponseBody] = await Promise.all([
                requestBodyPromise ?? Promise.resolve<HarBodyData>({ byteLength: 0 }),
                responseBodyPromise
            ]);
            const endTime = performance.now();
            const entry = await this.buildEntry(
                input,
                init,
                response,
                startedDateTime,
                startTime,
                endTime,
                resolvedResponseBody,
                requestBody
            );
            this.enqueueEntry(state, entry);
        } catch (error) {
            Logger.warn('[HAR] Failed to capture entry', error);
        }
    }

    private startCaptureTask(state: HarRecorderState, task: Promise<void>, controller?: AbortController): void {
        state.activeCaptureTasks.add(task);
        if (controller) {
            state.activeCaptureControllers.add(controller);
        }

        void task.finally(() => {
            state.activeCaptureTasks.delete(task);
            if (controller) {
                state.activeCaptureControllers.delete(controller);
            }
            if (!state.accepting) {
                this.finalizeStateIfIdle(state);
            }
        });
    }

    private enqueueEntry(state: HarRecorderState, entry: HarEntry): void {
        if (!state.accepting) {
            state.entries.push(entry);
            state.requestCount++;
            this.flush(state);
            this.finalizeStateIfIdle(state);
            return;
        }

        this.rotateFileIfDayChanged(state);

        state.entries.push(entry);
        state.requestCount++;

        // 达到单文件请求上限时，轮换到新文件
        if (state.requestCount >= this.MAX_REQUESTS_PER_FILE) {
            this.rotateFile(state, new Date(), 'request limit reached');
        }

        this.maybeFlush(state);
    }

    private rotateFileIfDayChanged(state: HarRecorderState): void {
        const now = new Date();
        if (shouldRotateHarFileForDayChange(state.fileDayKey, now, state.accepting)) {
            this.rotateFile(state, now, 'day changed');
        }
    }

    private rotateFile(state: HarRecorderState, now = new Date(), reason = 'rotation'): void {
        if (!state.options) {
            return;
        }

        // 先刷盘当前文件，确保数据不丢
        this.flush(state);

        // 清理旧文件（包含刚刷盘的文件），按 retentionCount 保留最近的
        this.cleanupOldHarFiles(state.storageDir, state.options.retentionCount, 1);

        // 创建新文件，重置计数和缓冲区
        const newFilePath = path.join(state.storageDir, this.generateFileName(now));
        state.filePath = newFilePath;
        state.fileDayKey = formatLocalDate(now);
        state.entries = [];
        state.requestCount = 0;
        state.lastFlushTime = Date.now();
        Logger.info(`[HAR] Rotated to new file (${reason}): ${newFilePath}`);
    }

    private maybeFlush(state: HarRecorderState): void {
        const now = Date.now();
        const dueToCount = state.entries.length >= FLUSH_ENTRY_THRESHOLD;
        const dueToTime = now - state.lastFlushTime >= FLUSH_INTERVAL_MS;
        const dueToBuffer = state.entries.length >= MAX_BUFFERED_ENTRIES;
        if (dueToCount || dueToTime || dueToBuffer) {
            this.flush(state);
        }
    }

    private startFlushTimer(state: HarRecorderState): void {
        this.stopFlushTimer(state);
        state.flushTimer = setInterval(() => this.maybeFlush(state), FLUSH_INTERVAL_MS);
        // 避免计时器阻塞 Node.js 进程退出
        if (typeof state.flushTimer.unref === 'function') {
            state.flushTimer.unref();
        }
    }

    private stopFlushTimer(state: HarRecorderState): void {
        if (state.flushTimer) {
            clearInterval(state.flushTimer);
            state.flushTimer = undefined;
        }
    }

    private flush(state: HarRecorderState): void {
        if (!state.filePath || state.entries.length === 0) {
            return;
        }

        try {
            const har = this.buildHar(state);
            const data = JSON.stringify(har, null, 2);
            fs.writeFileSync(state.filePath, data, { encoding: 'utf8', flush: true });
            state.lastFlushTime = Date.now();
        } catch (error) {
            Logger.warn('[HAR] Failed to flush HAR file', error);
        }
    }

    private buildHar(state: HarRecorderState): unknown {
        return {
            log: {
                version: '1.2',
                creator: {
                    name: 'GCMP',
                    version: state.options.extensionVersion ?? 'unknown'
                },
                pages: [],
                entries: state.entries
            }
        };
    }

    dispose(): void {
        this.disposeInternal();
        HarRecorder.instance = undefined;
    }

    private disposeInternal(): void {
        if (this.currentState) {
            const state = this.currentState;
            this.currentState = undefined;
            this.closeState(state);
        }
    }

    private closeState(state: HarRecorderState): void {
        if (!state.accepting) {
            this.finalizeStateIfIdle(state);
            return;
        }

        state.accepting = false;
        this.stopFlushTimer(state);
        this.flush(state);
        this.closingStates.add(state);
        for (const controller of state.activeCaptureControllers) {
            controller.abort();
        }
        this.finalizeStateIfIdle(state);
    }

    private finalizeStateIfIdle(state: HarRecorderState): void {
        if (!this.closingStates.has(state)) {
            return;
        }

        if (state.activeCaptureTasks.size > 0) {
            return;
        }

        this.flush(state);
        this.stopFlushTimer(state);
        this.closingStates.delete(state);
        Logger.info(`[HAR] Recording stopped, wrote ${state.entries.length} entries to ${state.filePath}`);
    }

    private generateFileName(now = new Date()): string {
        return buildHarFileName(now, process.pid, this.fileCounter++);
    }

    private ensureDirectory(dir: string): void {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }

    private cleanupOldHarFiles(dir: string, retentionCount: number, reserveSlotsForCurrentPid = 0): void {
        if (retentionCount <= 0) {
            return;
        }

        try {
            const currentPid = process.pid;
            const files: { name: string; path: string; mtime: number; pid: number }[] = [];
            for (const name of fs.readdirSync(dir)) {
                if (!name.endsWith('.har')) {
                    continue;
                }
                const filePath = path.join(dir, name);
                try {
                    const stat = fs.statSync(filePath);
                    const pid = parseHarPidFromFileName(name, currentPid);
                    files.push({ name, path: filePath, mtime: stat.mtimeMs, pid });
                } catch {
                    // 文件可能已被其他实例删除，跳过
                }
            }

            const deleteFile = (file: HarFileRecord, reason: string): void => {
                try {
                    fs.unlinkSync(file.path);
                    Logger.debug(`[HAR] ${reason}: ${file.name}`);
                } catch {
                    Logger.debug(`[HAR] Skipped deleting HAR file ${file.name} (${reason}, in use or already removed)`);
                }
            };

            const deletePaths = planHarCleanup(
                files,
                retentionCount,
                Date.now(),
                currentPid,
                reserveSlotsForCurrentPid
            );
            for (const filePath of deletePaths) {
                const file = files.find(item => item.path === filePath);
                if (file) {
                    deleteFile(file, 'Cleaned up old HAR file');
                }
            }
        } catch (error) {
            Logger.warn('[HAR] Failed to clean up old HAR files', error);
        }
    }

    private async buildEntry(
        input: string | URL | Request,
        init: RequestInit | undefined,
        response: Response,
        startedDateTime: string,
        startTime: number,
        endTime: number,
        responseBody: HarBodyData,
        requestBody: HarBodyData
    ): Promise<HarEntry> {
        const url =
            typeof input === 'string' ? input
            : input instanceof URL ? input.href
            : input.url;
        const method = init?.method || (input instanceof Request ? input.method : 'GET');
        const requestHeaders = this.headersToRecord(
            init?.headers || (input instanceof Request ? input.headers : undefined)
        );
        const requestContentType = this.getContentType(requestHeaders) || this.inferRequestContentType(init?.body);

        const responseHeaders = this.headersToRecord(response.headers);
        const responseContentType = this.getContentType(responseHeaders);
        const responseBodySize = this.parseContentLength(responseHeaders) ?? responseBody.byteLength;
        const redirectUrl = this.getHeaderValue(responseHeaders, 'location');
        const responseContent: HarResponse['content'] = {
            size: responseBody.byteLength,
            mimeType: responseContentType || 'text/plain',
            text: responseBody.text
        };
        const compression = calculateHarCompression(responseBody.byteLength, responseBodySize);
        if (compression !== undefined) {
            responseContent.compression = compression;
        }

        return {
            startedDateTime,
            time: Math.round(endTime - startTime),
            request: {
                method,
                url: this.sanitizeUrl(url),
                httpVersion: 'HTTP/1.1',
                headers: this.sanitizeHeaders(requestHeaders),
                cookies: [],
                queryString: this.parseQueryString(url),
                postData:
                    requestBody.text !== undefined ?
                        {
                            mimeType: requestContentType || 'application/octet-stream',
                            text: requestBody.text
                        }
                    :   undefined,
                headersSize: this.estimateHeadersSize(method, url, requestHeaders),
                bodySize: requestBody.byteLength
            },
            response: {
                status: response.status,
                statusText: response.statusText,
                httpVersion: 'HTTP/1.1',
                headers: this.sanitizeHeaders(responseHeaders),
                cookies: [],
                content: responseContent,
                redirectURL: redirectUrl ? this.sanitizeUrl(redirectUrl) : '',
                headersSize: this.estimateHeadersSize('', '', responseHeaders),
                bodySize: responseBodySize
            },
            cache: {},
            timings: {
                blocked: -1,
                dns: -1,
                connect: -1,
                send: 0,
                wait: Math.round(endTime - startTime),
                receive: 0,
                ssl: -1
            }
        };
    }

    private headersToRecord(headers?: HeadersInit): HarHeader[] {
        if (!headers) {
            return [];
        }

        const result: HarHeader[] = [];
        if (Array.isArray(headers)) {
            for (const [key, value] of headers) {
                result.push({ name: key, value: String(value ?? '') });
            }
            return result;
        }

        const setCookieHeaders = this.getSetCookieHeaderValues(headers);
        if (this.isIterableHeaders(headers)) {
            for (const [key, value] of headers as Iterable<[string, string]>) {
                if (setCookieHeaders.length > 0 && key.toLowerCase() === 'set-cookie') {
                    continue;
                }
                result.push({ name: key, value });
            }
            for (const cookie of setCookieHeaders) {
                result.push({ name: 'set-cookie', value: cookie });
            }
            return result;
        }

        for (const [key, value] of Object.entries(headers)) {
            result.push({ name: key, value: String(value ?? '') });
        }
        return result;
    }

    private isIterableHeaders(headers: unknown): headers is Iterable<[string, string]> {
        return (
            typeof headers === 'object' &&
            headers !== null &&
            typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function'
        );
    }

    private sanitizeHeaders(headers: HarHeader[]): HarHeader[] {
        return headers.map(({ name, value }) => ({
            name,
            value: sensitiveHeaderNamePattern.test(name) ? '***' : this.maskSecretsInText(value)
        }));
    }

    private async readRequestBody(
        body: BodyInit | undefined | null,
        signal?: AbortSignal
    ): Promise<{ text?: string; byteLength: number }> {
        return readBodyData(body, signal);
    }

    private async readResponseBody(
        response: Response,
        signal?: AbortSignal
    ): Promise<{ text?: string; byteLength: number }> {
        return readResponseBodyData(response, signal);
    }

    private inferRequestContentType(body: BodyInit | undefined | null): string | undefined {
        if (body === undefined || body === null) {
            return undefined;
        }
        if (typeof body === 'string') {
            return 'text/plain';
        }
        if (
            Buffer.isBuffer(body) ||
            body instanceof Uint8Array ||
            body instanceof ArrayBuffer ||
            body instanceof Blob
        ) {
            return 'application/octet-stream';
        }
        if (body instanceof URLSearchParams) {
            return 'application/x-www-form-urlencoded';
        }
        if (body instanceof FormData) {
            return 'multipart/form-data';
        }
        return 'application/octet-stream';
    }

    private sanitizeUrl(url: string): string {
        try {
            const u = new URL(url);
            const entries: string[][] = Array.from(u.searchParams.entries()).map(([key, value]) => [
                key,
                sensitiveFieldPattern.test(key) ? '***' : this.maskSecretsInText(value)
            ]);
            u.search = new URLSearchParams(entries).toString();
            return u.toString();
        } catch {
            return this.maskSecretsInText(url);
        }
    }

    private parseQueryString(url: string): HarQueryString[] {
        try {
            const u = new URL(url);
            return Array.from(u.searchParams.entries()).map(([name, value]) => ({
                name,
                value: sensitiveFieldPattern.test(name) ? '***' : this.maskSecretsInText(value)
            }));
        } catch {
            return [];
        }
    }

    private maskSecretsInText(text: string): string {
        if (text.length > maxBodySize * 2) {
            // 对超大文本分段处理，避免正则回溯导致性能问题
            const chunks: string[] = [];
            for (let i = 0; i < text.length; i += maxBodySize) {
                chunks.push(text.slice(i, i + maxBodySize));
            }
            return chunks.map(chunk => this.maskSecretsInChunk(chunk)).join('');
        }
        return this.maskSecretsInChunk(text);
    }

    private maskSecretsInChunk(text: string): string {
        return text
            .replace(/\bBearer\s+[A-Za-z0-9\-_~+/]+=*\b/g, 'Bearer ***')
            .replace(/\bBasic\s+[A-Za-z0-9+/=]+\b/g, 'Basic ***')
            .replace(/\bsk-[a-zA-Z0-9]{10,}\b/g, 'sk-***')
            .replace(/\bsess-[a-zA-Z0-9]{10,}\b/g, 'sess-***')
            .replace(/\breq_[a-zA-Z0-9]{10,}\b/g, 'req_***')
            .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***')
            .replace(/\beyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*\b/g, '***');
    }

    private getContentType(headers: HarHeader[]): string | undefined {
        return this.getHeaderValue(headers, 'content-type');
    }

    private getHeaderValue(headers: HarHeader[], name: string): string | undefined {
        const lowerName = name.toLowerCase();
        return headers.find(header => header.name.toLowerCase() === lowerName)?.value;
    }

    private hasHeader(headers: HarHeader[], name: string): boolean {
        const lowerName = name.toLowerCase();
        return headers.some(header => header.name.toLowerCase() === lowerName);
    }

    private getSetCookieHeaderValues(headers: HeadersInit): string[] {
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
            if (typeof getSetCookie === 'function') {
                return getSetCookie.call(headers);
            }
        }
        return [];
    }

    private estimateHeadersSize(method: string, url: string, headers: HarHeader[]): number {
        let size = 0;
        if (method) {
            // 请求行
            size += `${method} ${url || '/'} HTTP/1.1\r\n`.length;
        } else {
            // 状态行（响应）
            size += 'HTTP/1.1 200 OK\r\n'.length;
        }
        for (const header of headers) {
            size += `${header.name}: ${header.value}\r\n`.length;
        }
        // 补充 HTTP 客户端通常会隐式添加的头，使 headersSize 更接近真实值
        if (method && !this.hasHeader(headers, 'host')) {
            try {
                size += `Host: ${new URL(url).host}\r\n`.length;
            } catch {
                // 忽略无效 URL
            }
        }
        if (method && !this.hasHeader(headers, 'connection')) {
            size += 'Connection: keep-alive\r\n'.length;
        }
        if (method && !this.hasHeader(headers, 'accept-encoding')) {
            size += 'Accept-Encoding: br, gzip, deflate\r\n'.length;
        }
        size += 2; // 结束空行 \r\n
        return size;
    }

    private parseContentLength(headers: HarHeader[]): number | undefined {
        const value = this.getHeaderValue(headers, 'content-length');
        if (!value) {
            return undefined;
        }
        const parsed = Number.parseInt(value, 10);
        return Number.isNaN(parsed) ? undefined : parsed;
    }
}
