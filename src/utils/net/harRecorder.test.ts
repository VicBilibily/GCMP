import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
    buildHarFileName,
    calculateHarCompression,
    formatLocalDate,
    nowMicros,
    observeResponseBodyData,
    parseHarPidFromFileName,
    pickLatestHarFile,
    planHarCleanup,
    readBodyData,
    readResponseBodyData,
    shouldRotateHarFileForAge,
    shouldRotateHarFileForDayChange,
    type HarFileRecord
} from './harRecorderHelpers';

test('readBodyData preserves full text for large string bodies', async () => {
    const body = 'request-body-Bearer secret-token-api_key=abc123-' + 'x'.repeat(1024 * 1024 + 512);
    const result = await readBodyData(body);

    assert.equal(result.text, body);
    assert.equal(result.byteLength, Buffer.byteLength(body, 'utf8'));
    assert.equal(result.text?.includes('[HAR body truncated]'), false);
});

test('readBodyData preserves full stream and form-data bodies', async () => {
    const streamText = 'stream-body-' + 'a'.repeat(4096);
    const encoder = new TextEncoder();
    const streamResult = await readBodyData(
        new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(streamText));
                controller.close();
            }
        })
    );

    assert.equal(streamResult.text, streamText);
    assert.equal(streamResult.byteLength, Buffer.byteLength(streamText, 'utf8'));

    const formData = new FormData();
    formData.set('alpha', 'one');
    formData.set('beta', 'two');
    const formDataResult = await readBodyData(formData);

    assert.equal(formDataResult.byteLength > 0, true);
    assert.equal(formDataResult.text?.includes('name="alpha"'), true);
    assert.equal(formDataResult.text?.includes('one'), true);
    assert.equal(formDataResult.text?.includes('name="beta"'), true);
    assert.equal(formDataResult.text?.includes('two'), true);
});

test('readBodyData returns received prefix when aborted', async () => {
    const controller = new AbortController();
    const streamText = 'stream-body-prefix';
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
            streamController.enqueue(encoder.encode(streamText));
        }
    });

    const readPromise = readBodyData(stream, controller.signal);
    await delay(0);
    controller.abort();

    const result = await readPromise;

    assert.equal(result.text, streamText);
    assert.equal(result.byteLength, Buffer.byteLength(streamText, 'utf8'));
});

test('readResponseBodyData preserves full response text', async () => {
    const responseText = 'response-body-Bearer secret-token-api_key=abc123-' + 'y'.repeat(1024 * 1024 + 512);
    const result = await readResponseBodyData(new Response(responseText));

    assert.equal(result.text, responseText);
    assert.equal(result.byteLength, Buffer.byteLength(responseText, 'utf8'));
});

test('readResponseBodyData returns received prefix when aborted', async () => {
    const controller = new AbortController();
    const responseText = 'response-body-prefix';
    const encoder = new TextEncoder();
    const response = new Response(
        new ReadableStream<Uint8Array>({
            start(streamController) {
                streamController.enqueue(encoder.encode(responseText));
            }
        })
    );

    const readPromise = readResponseBodyData(response, controller.signal);
    await delay(0);
    controller.abort();

    const result = await readPromise;

    assert.equal(result.text, responseText);
    assert.equal(result.byteLength, Buffer.byteLength(responseText, 'utf8'));
});

test('observeResponseBodyData never reads ahead of the business consumer', async () => {
    const text = 'data: {"type":"response.completed"}\n\n';
    let pulls = 0;
    let cancels = 0;
    const reason = new Error('terminal consumed');
    const original = new Response(
        new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    pulls++;
                    if (pulls === 1) {
                        controller.enqueue(new TextEncoder().encode(text));
                    } else {
                        controller.error(new TypeError('terminated'));
                    }
                },
                cancel(value) {
                    assert.equal(value, reason);
                    cancels++;
                }
            },
            { highWaterMark: 0 }
        )
    );
    const capture = observeResponseBodyData(original);
    await nextTurn();
    assert.equal(pulls, 0);
    assert.equal(original.body!.locked, false);
    const reader = capture.response.body!.getReader();
    try {
        assert.equal(new TextDecoder().decode((await reader.read()).value), text);
        await nextTurn();
        assert.equal(pulls, 1);
        await reader.cancel(reason);
        assert.deepEqual(await capture.body, { text, byteLength: Buffer.byteLength(text), aborted: true });
        assert.equal(cancels, 1);
        assert.equal(original.body!.locked, false);
    } finally {
        reader.releaseLock();
    }
});

test('observeResponseBodyData preserves the original read error and captured prefix', async () => {
    const failure = new TypeError('terminated');
    let pulls = 0;
    const original = new Response(
        new ReadableStream<Uint8Array>(
            {
                pull(controller) {
                    if (++pulls === 1) {
                        controller.enqueue(new TextEncoder().encode('prefix'));
                    } else {
                        controller.error(failure);
                    }
                }
            },
            { highWaterMark: 0 }
        )
    );
    const capture = observeResponseBodyData(original);
    const reader = capture.response.body!.getReader();
    try {
        await reader.read();
        await assert.rejects(reader.read(), error => error === failure);
        assert.deepEqual(await capture.body, { text: 'prefix', byteLength: 6 });
        assert.equal(original.body!.locked, false);
    } finally {
        reader.releaseLock();
    }
});

test('observeResponseBodyData stops capture without interrupting a pending business read', async () => {
    const stop = new AbortController();
    const request = new AbortController();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    let cancels = 0;
    const original = new Response(
        new ReadableStream<Uint8Array>(
            {
                start(controller) {
                    upstream = controller;
                    controller.enqueue(new TextEncoder().encode('prefix'));
                },
                cancel() {
                    cancels++;
                }
            },
            { highWaterMark: 0 }
        )
    );
    const capture = observeResponseBodyData(original, stop.signal, request.signal);
    const reader = capture.response.body!.getReader();
    try {
        await reader.read();
        let settled = false;
        const pending = reader.read().then(value => {
            settled = true;
            return value;
        });
        stop.abort();
        assert.deepEqual(await capture.body, { text: 'prefix', byteLength: 6, aborted: true });
        await nextTurn();
        assert.equal(settled, false);
        assert.equal(cancels, 0);
        assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
        assert.equal(getEventListeners(request.signal, 'abort').length, 0);
        upstream.enqueue(new TextEncoder().encode('suffix'));
        upstream.close();
        assert.equal(new TextDecoder().decode((await pending).value), 'suffix');
        assert.equal((await reader.read()).done, true);
        assert.equal(original.body!.locked, false);
    } finally {
        reader.releaseLock();
    }
});

for (const alreadyAborted of [false, true]) {
    test(`observeResponseBodyData settles unread capture on request abort: already=${alreadyAborted}`, async () => {
        const stop = new AbortController();
        const request = new AbortController();
        if (alreadyAborted) {
            request.abort();
        }
        const capture = observeResponseBodyData(new Response('still readable'), stop.signal, request.signal);
        if (!alreadyAborted) {
            request.abort();
        }
        assert.deepEqual(await capture.body, { text: '', byteLength: 0, aborted: true });
        assert.equal(await capture.response.text(), 'still readable');
        assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
        assert.equal(getEventListeners(request.signal, 'abort').length, 0);
    });
}

for (const pendingRead of [false, true]) {
    for (const rejectCleanup of [false, true]) {
        test(`observeResponseBodyData propagates cancellation: pending=${pendingRead}, reject=${rejectCleanup}`, async () => {
            const reason = new Error('consumer cancelled');
            let cancels = 0;
            const original = new Response(
                new ReadableStream<Uint8Array>(
                    {
                        cancel(actualReason) {
                            assert.equal(actualReason, reason);
                            cancels++;
                            if (rejectCleanup) {
                                return Promise.reject(new Error('cleanup failure'));
                            }
                        }
                    },
                    { highWaterMark: 0 }
                )
            );
            const capture = observeResponseBodyData(original);
            const reader = capture.response.body!.getReader();
            try {
                const pending = pendingRead ? reader.read() : undefined;
                await nextTurn();
                await reader.cancel(reason);
                if (pending) {
                    assert.equal((await pending).done, true);
                }
                await nextTurn();
                assert.deepEqual(await capture.body, { text: '', byteLength: 0, aborted: true });
                assert.equal(cancels, 1);
                assert.equal(original.body!.locked, false);
            } finally {
                reader.releaseLock();
            }
        });
    }
}

test('observeResponseBodyData preserves metadata and body methods without cloning the source', async () => {
    const original = new Response('{"ok":true}', {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json', 'x-request-id': 'review' }
    });
    let sourceClones = 0;
    Object.defineProperties(original, {
        url: { value: 'https://example.test/v1/responses' },
        redirected: { value: true },
        type: { value: 'basic' },
        clone: {
            value: () => {
                sourceClones++;
                throw new Error('source clone unavailable');
            }
        }
    });
    const stop = new AbortController();
    const capture = observeResponseBodyData(original, stop.signal);
    assert.equal(capture.response.bodyUsed, false);
    const cloned = capture.response.clone();
    for (const response of [capture.response, cloned]) {
        assert.equal(response.url, original.url);
        assert.equal(response.redirected, true);
        assert.equal(response.type, 'basic');
        assert.equal(response.status, 201);
        assert.equal(response.statusText, 'Created');
        assert.equal(response.headers.get('x-request-id'), 'review');
    }
    const [parsed, text] = await Promise.all([capture.response.json(), cloned.text()]);
    assert.deepEqual(parsed, { ok: true });
    assert.equal(text, '{"ok":true}');
    assert.deepEqual(await capture.body, { text, byteLength: Buffer.byteLength(text) });
    assert.equal(capture.response.bodyUsed, true);
    assert.equal(sourceClones, 0);
    assert.equal(original.body!.locked, false);
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0);
});

test('observeResponseBodyData copies captured bytes before handing them to the consumer', async () => {
    const capture = observeResponseBodyData(new Response('original'));
    const reader = capture.response.body!.getReader();
    try {
        (await reader.read()).value!.fill(0);
        assert.equal((await reader.read()).done, true);
        assert.deepEqual(await capture.body, { text: 'original', byteLength: 8 });
    } finally {
        reader.releaseLock();
    }
});

test('observeResponseBodyData preserves responses without a body', async () => {
    const original = new Response(null, { status: 204 });
    const capture = observeResponseBodyData(original);
    assert.equal(capture.response, original);
    assert.deepEqual(await capture.body, { byteLength: 0 });
});

test('parseHarPidFromFileName supports legacy and new file name formats', () => {
    assert.equal(parseHarPidFromFileName('gcmp_2026-07-12T10-00-00-000_1234.har', 1), 1234);
    assert.equal(parseHarPidFromFileName('gcmp_2026-07-12T10-00-00-000_5678_9.har', 1), 5678);
    assert.equal(buildHarFileName(new Date('2026-07-12T10:00:00.123'), 4321, 7).includes('_4321_7.har'), true);
    assert.equal(formatLocalDate(new Date('2026-07-12T10:00:00.123')), '2026-07-12');
});

test('nowMicros returns microsecond epoch consistent with Date.now and monotonic non-decreasing', () => {
    const beforeMs = Date.now();
    const ts = nowMicros();
    const afterMs = Date.now();

    // 应为 16 位微秒级整数（13 位毫秒级 × 1000），对齐 Reqable 的 _endTimestamp 精度
    assert.equal(ts > 1_000_000_000_000_000, true);
    assert.equal(ts < 100_000_000_000_000_000, true);
    assert.equal(Number.isInteger(ts), true);

    // 与 Date.now() 应在 ±2ms 内一致（允许 event loop 调度抖动）
    const tsMs = ts / 1000;
    assert.equal(tsMs >= beforeMs - 2 && tsMs <= afterMs + 2, true);

    // 单调非递减（连续调用）
    const ts2 = nowMicros();
    assert.equal(ts2 >= ts, true);
});

test('pickLatestHarFile prefers current pid files even when other pid files are newer', () => {
    const currentPid = 4321;
    const files: HarFileRecord[] = [
        { name: 'a.har', path: '/dir/a.har', mtime: 1_000, pid: 1111 },
        { name: 'b.har', path: '/dir/b.har', mtime: 3_000, pid: 1111 }, // 其他 PID 最新
        { name: 'c.har', path: '/dir/c.har', mtime: 2_000, pid: 4321 } // 当前 PID 较旧
    ];

    const result = pickLatestHarFile(files, currentPid);
    assert.equal(result?.path, '/dir/c.har');
});

test('pickLatestHarFile returns undefined when current pid has no files', () => {
    const files: HarFileRecord[] = [
        { name: 'a.har', path: '/dir/a.har', mtime: 1_000, pid: 1111 },
        { name: 'b.har', path: '/dir/b.har', mtime: 3_000, pid: 2222 }
    ];

    // 当前 PID 无文件时返回 undefined，避免跨进程串味、错误定位到其他实例的记录
    assert.equal(pickLatestHarFile(files, 4321), undefined);
});

test('pickLatestHarFile returns undefined for empty list', () => {
    assert.equal(pickLatestHarFile([], 4321), undefined);
});

test('calculateHarCompression returns bytes saved for compressed responses only', () => {
    assert.equal(calculateHarCompression(1200, 450), 750);
    assert.equal(calculateHarCompression(450, 450), undefined);
    assert.equal(calculateHarCompression(450, 600), undefined);
});

test('shouldRotateHarFileForDayChange only rotates when accepting and date changes', () => {
    const nextDay = new Date('2026-07-13T00:00:00.000');

    assert.equal(shouldRotateHarFileForDayChange('2026-07-12', nextDay, true), true);
    assert.equal(shouldRotateHarFileForDayChange('2026-07-12', nextDay, false), false);
    assert.equal(shouldRotateHarFileForDayChange('2026-07-13', nextDay, true), false);
});

test('shouldRotateHarFileForAge only rotates when accepting and age exceeds interval', () => {
    const now = 1_000_000_000;
    const interval = 30 * 60 * 1000;

    // 刚好超过阈值 → 轮换
    assert.equal(shouldRotateHarFileForAge(now - interval - 1, now, interval, true), true);
    // 非接受状态 → 不轮换
    assert.equal(shouldRotateHarFileForAge(now - interval - 1, now, interval, false), false);
    // 未超阈值 → 不轮换
    assert.equal(shouldRotateHarFileForAge(now - interval + 1, now, interval, true), false);
    // 刚好等于阈值 → 轮换（>= 语义）
    assert.equal(shouldRotateHarFileForAge(now - interval, now, interval, true), true);
});

test('planHarCleanup deletes files older than the 2-hour stale cutoff', () => {
    const now = Date.now();
    const files: HarFileRecord[] = [
        { name: 'stale.har', path: '/tmp/stale.har', mtime: now - 3 * 60 * 60 * 1000, pid: 1001 },
        { name: 'fresh.har', path: '/tmp/fresh.har', mtime: now - 5 * 60 * 1000, pid: 1002 }
    ];

    const deletePaths = new Set(planHarCleanup(files, 10, now));

    assert.equal(deletePaths.has('/tmp/stale.har'), true);
    assert.equal(deletePaths.has('/tmp/fresh.har'), false);
});

test('planHarCleanup still deletes stale files when retentionCount is zero', () => {
    const now = Date.now();
    const files: HarFileRecord[] = [
        { name: 'stale.har', path: '/tmp/stale.har', mtime: now - 3 * 60 * 60 * 1000, pid: 1001 },
        { name: 'pid-a-old.har', path: '/tmp/pid-a-old.har', mtime: now - 4_000, pid: 3001 },
        { name: 'pid-a-new.har', path: '/tmp/pid-a-new.har', mtime: now - 3_000, pid: 3001 }
    ];

    const deletePaths = new Set(planHarCleanup(files, 0, now));

    assert.equal(deletePaths.has('/tmp/stale.har'), true);
    assert.equal(deletePaths.has('/tmp/pid-a-old.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-a-new.har'), false);
});

test('planHarCleanup removes stale files and keeps recent files per pid', () => {
    const now = Date.now();
    const files: HarFileRecord[] = [
        { name: 'stale.har', path: '/tmp/stale.har', mtime: now - 3 * 24 * 60 * 60 * 1000, pid: 1001 },
        { name: 'legacy-keep.har', path: '/tmp/legacy-keep.har', mtime: now - 5_000, pid: 2001 },
        { name: 'pid-a-old.har', path: '/tmp/pid-a-old.har', mtime: now - 4_000, pid: 3001 },
        { name: 'pid-a-new.har', path: '/tmp/pid-a-new.har', mtime: now - 3_000, pid: 3001 },
        { name: 'pid-b.har', path: '/tmp/pid-b.har', mtime: now - 2_000, pid: 4001 },
        { name: 'pid-c.har', path: '/tmp/pid-c.har', mtime: now - 1_000, pid: 5001 },
        { name: 'pid-d.har', path: '/tmp/pid-d.har', mtime: now - 500, pid: 6001 },
        { name: 'pid-e.har', path: '/tmp/pid-e.har', mtime: now - 100, pid: 7001 }
    ];

    const deletePaths = new Set(planHarCleanup(files, 1, now));

    assert.equal(deletePaths.has('/tmp/stale.har'), true);
    assert.equal(deletePaths.has('/tmp/pid-a-old.har'), true);
    assert.equal(deletePaths.has('/tmp/legacy-keep.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-a-new.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-b.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-c.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-d.har'), false);
    assert.equal(deletePaths.has('/tmp/pid-e.har'), false);
});

test('planHarCleanup reserves one slot for the current pid upcoming file', () => {
    const now = Date.now();
    const files: HarFileRecord[] = [
        { name: 'pid-a-old.har', path: '/tmp/pid-a-old.har', mtime: now - 4_000, pid: 3001 },
        { name: 'pid-a-new.har', path: '/tmp/pid-a-new.har', mtime: now - 3_000, pid: 3001 },
        { name: 'pid-b.har', path: '/tmp/pid-b.har', mtime: now - 2_000, pid: 4001 }
    ];

    const deletePaths = new Set(planHarCleanup(files, 1, now, 3001, 1));

    assert.equal(deletePaths.has('/tmp/pid-a-old.har'), true);
    assert.equal(deletePaths.has('/tmp/pid-a-new.har'), true);
    assert.equal(deletePaths.has('/tmp/pid-b.har'), false);
});
