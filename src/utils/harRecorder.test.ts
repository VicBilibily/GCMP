import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import {
    buildHarFileName,
    calculateHarCompression,
    formatLocalDate,
    parseHarPidFromFileName,
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

test('parseHarPidFromFileName supports legacy and new file name formats', () => {
    assert.equal(parseHarPidFromFileName('gcmp_2026-07-12T10-00-00-000_1234.har', 1), 1234);
    assert.equal(parseHarPidFromFileName('gcmp_2026-07-12T10-00-00-000_5678_9.har', 1), 5678);
    assert.equal(buildHarFileName(new Date('2026-07-12T10:00:00.123'), 4321, 7).includes('_4321_7.har'), true);
    assert.equal(formatLocalDate(new Date('2026-07-12T10:00:00.123')), '2026-07-12');
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
    const interval = 2 * 60 * 60 * 1000;

    // 刚好超过阈值 → 轮换
    assert.equal(shouldRotateHarFileForAge(now - interval - 1, now, interval, true), true);
    // 非接受状态 → 不轮换
    assert.equal(shouldRotateHarFileForAge(now - interval - 1, now, interval, false), false);
    // 未超阈值 → 不轮换
    assert.equal(shouldRotateHarFileForAge(now - interval + 1, now, interval, true), false);
    // 刚好等于阈值 → 轮换（>= 语义）
    assert.equal(shouldRotateHarFileForAge(now - interval, now, interval, true), true);
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
