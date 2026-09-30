import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { type InterInstanceEvent, parseEventsFromBuffer, serializeEvent } from '../../src/interInstance/eventProtocol';
import { FallbackTransport } from '../../src/interInstance/fallbackTransport';

interface FallbackTransportInternals {
    ownFilePath: string;
    fileStates: Map<
        string,
        {
            position: number;
            remaining: string;
            continuityTail?: Buffer;
            seenEvents?: Map<string, number>;
            seenEventBytes?: number;
        }
    >;
    readNewEvents: (filePath: string, replayed?: boolean) => Promise<void>;
}

suite('Fallback transport regressions', () => {
    test('fallback truncation replays retained events and delivers the appended event live', async () => {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-'));
        const filePath = path.join(directory, 'events-remote.jsonl');
        const received: Array<{ event: InterInstanceEvent; replayed: boolean }> = [];
        const writer = new FallbackTransport({ instanceId: 'remote', onEvent: () => {} });
        const reader = new FallbackTransport({
            instanceId: 'local',
            onEvent: (event, replayed) => received.push({ event, replayed })
        });
        const writerInternals = writer as unknown as FallbackTransportInternals;
        const readerInternals = reader as unknown as FallbackTransportInternals;

        try {
            const lines: string[] = [];
            let oldSize = 0;
            for (let index = 0; oldSize <= 1024 * 1024 + 4096; index++) {
                const line = serializeEvent({
                    type: 'configChanged',
                    senderInstanceId: 'remote',
                    timestamp: index + 1,
                    payload: { changedKeys: [`historical-${index}-${'x'.repeat(160)}`] }
                });
                lines.push(line);
                oldSize += Buffer.byteLength(line);
            }
            const retainedReset = serializeEvent({
                type: 'apiKeyFailoverReset',
                senderInstanceId: 'remote',
                timestamp: lines.length + 1,
                payload: {
                    requestId: 'retained-reset',
                    failureRequestId: 'retained-failure',
                    requestedBy: 'remote',
                    authorityTerm: 'remote:1',
                    slot: 'openai'
                }
            });
            lines.push(retainedReset);
            oldSize += Buffer.byteLength(retainedReset);
            const oldContent = Buffer.from(lines.join(''));
            await fs.promises.writeFile(filePath, oldContent);

            let position = 0;
            for (const line of lines) {
                position += Buffer.byteLength(line);
                if (position >= 64 * 1024) {
                    break;
                }
            }
            readerInternals.fileStates.set(filePath, {
                position,
                remaining: '',
                continuityTail: Buffer.from(oldContent.subarray(position - 64, position))
            });
            writerInternals.ownFilePath = filePath;

            const liveEvent: InterInstanceEvent = {
                type: 'configChanged',
                senderInstanceId: 'remote',
                timestamp: Date.now(),
                payload: { changedKeys: ['live-after-truncation'] }
            };
            await writer.publish(liveEvent);
            const compactedContent = await fs.promises.readFile(filePath, 'utf8');
            assert.ok(Buffer.byteLength(compactedContent) < oldSize);

            const oldReaderEvents = parseEventsFromBuffer(compactedContent).events;
            assert.equal(oldReaderEvents.filter(event => event.type === 'apiKeyFailoverReset').length, 1);
            assert.equal(
                oldReaderEvents.filter(
                    event =>
                        event.type === 'configChanged' && event.payload.changedKeys.includes('live-after-truncation')
                ).length,
                1
            );
            assert.equal(
                oldReaderEvents.some(
                    event =>
                        event.type === 'configChanged' &&
                        event.payload.changedKeys.some(key => key.startsWith('historical-'))
                ),
                false
            );

            await readerInternals.readNewEvents(filePath);

            const live = received.filter(
                entry =>
                    entry.event.type === 'configChanged' &&
                    entry.event.payload.changedKeys.includes('live-after-truncation')
            );
            assert.equal(live.length, 1);
            assert.equal(live[0].replayed, false);
            assert.ok(received.some(entry => entry.event.type === 'apiKeyFailoverReset' && entry.replayed));
            assert.equal(received.filter(entry => !entry.replayed).length, 1);
        } finally {
            await writer.stop();
            await reader.stop();
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });

    for (const [readEmptyTruncation, phasedHistoryWrite] of [
        [false, false],
        [true, false],
        [false, true]
    ]) {
        test(`fallback reader preserves legacy history before a delayed append: empty=${readEmptyTruncation}, phased=${phasedHistoryWrite}`, async () => {
            const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-legacy-'));
            const filePath = path.join(directory, 'events-remote.jsonl');
            const received: Array<{ event: InterInstanceEvent; replayed: boolean }> = [];
            const reader = new FallbackTransport({
                instanceId: 'local',
                onEvent: (event, replayed) => received.push({ event, replayed })
            });
            const readerInternals = reader as unknown as FallbackTransportInternals;

            try {
                const historicalLines = Array.from({ length: 3 }, (_, index) =>
                    serializeEvent({
                        type: 'configChanged',
                        senderInstanceId: 'remote',
                        timestamp: index + 1,
                        payload: { changedKeys: [`legacy-historical-${index}`] }
                    })
                );
                const historical = historicalLines.join('');
                const padding = serializeEvent({
                    type: 'configChanged',
                    senderInstanceId: 'remote',
                    timestamp: 4,
                    payload: { changedKeys: ['x'.repeat(1024)] }
                });
                await fs.promises.writeFile(filePath, historical + padding, 'utf8');
                readerInternals.fileStates.set(filePath, {
                    position: 0,
                    remaining: ''
                });
                await readerInternals.readNewEvents(filePath);
                received.length = 0;

                if (readEmptyTruncation) {
                    await fs.promises.writeFile(filePath, '', 'utf8');
                    await readerInternals.readNewEvents(filePath);
                }
                await fs.promises.writeFile(filePath, phasedHistoryWrite ? historicalLines[0] : historical, 'utf8');
                await readerInternals.readNewEvents(filePath);
                assert.equal(received.length, phasedHistoryWrite ? 1 : 3);
                assert.ok(received.every(entry => entry.replayed));
                if (phasedHistoryWrite) {
                    await fs.promises.appendFile(filePath, historicalLines.slice(1).join(''), 'utf8');
                    await readerInternals.readNewEvents(filePath);
                    assert.equal(received.length, 3);
                    assert.ok(received.every(entry => entry.replayed));
                }

                await fs.promises.appendFile(
                    filePath,
                    serializeEvent({
                        type: 'configChanged',
                        senderInstanceId: 'remote',
                        timestamp: 5,
                        payload: { changedKeys: ['legacy-live-after-truncation'] }
                    }),
                    'utf8'
                );
                await readerInternals.readNewEvents(filePath);

                const historicalEvents = received.filter(
                    entry =>
                        entry.event.type === 'configChanged' &&
                        entry.event.payload.changedKeys.some(key => key.startsWith('legacy-historical-'))
                );
                const liveEvents = received.filter(
                    entry =>
                        entry.event.type === 'configChanged' &&
                        entry.event.payload.changedKeys.includes('legacy-live-after-truncation')
                );
                assert.equal(historicalEvents.length, 3);
                assert.ok(historicalEvents.every(entry => entry.replayed));
                assert.equal(liveEvents.length, 1);
                assert.equal(liveEvents[0].replayed, false);
            } finally {
                await reader.stop();
                await fs.promises.rm(directory, { recursive: true, force: true });
            }
        });
    }

    const shortReadCases: {
        name: string;
        mode: 'startup' | 'marked-rewrite' | 'legacy-rewrite';
        split: 'lines' | 'utf8' | 'boundary' | 'none';
        appendDuringRead?: boolean;
        repeatHistoricalLive?: boolean;
        probeReadLimit?: number;
    }[] = [
        { name: 'startup history', mode: 'startup', split: 'lines' },
        { name: 'startup UTF-8 history', mode: 'startup', split: 'utf8' },
        { name: 'startup history with a short continuity probe', mode: 'startup', split: 'lines', probeReadLimit: 32 },
        {
            name: 'startup UTF-8 history with bytewise continuity probes',
            mode: 'startup',
            split: 'utf8',
            probeReadLimit: 1
        },
        {
            name: 'startup short continuity probes followed by live append',
            mode: 'startup',
            split: 'lines',
            probeReadLimit: 16,
            appendDuringRead: true
        },
        { name: 'startup history followed by live append', mode: 'startup', split: 'lines', appendDuringRead: true },
        { name: 'rewrite boundary in a later read', mode: 'marked-rewrite', split: 'lines' },
        { name: 'rewrite boundary split across reads', mode: 'marked-rewrite', split: 'boundary' },
        {
            name: 'rewrite boundary with short continuity probes',
            mode: 'marked-rewrite',
            split: 'boundary',
            probeReadLimit: 16
        },
        {
            name: 'marked rewrite with a repeated live event',
            mode: 'marked-rewrite',
            split: 'none',
            repeatHistoricalLive: true
        },
        { name: 'legacy rewrite history', mode: 'legacy-rewrite', split: 'lines' },
        {
            name: 'legacy rewrite with short continuity probes',
            mode: 'legacy-rewrite',
            split: 'lines',
            probeReadLimit: 16
        },
        { name: 'completed legacy rewrite', mode: 'legacy-rewrite', split: 'none' }
    ];

    for (const scenario of shortReadCases) {
        test(`fallback reader preserves replay classification: ${scenario.name}`, async () => {
            const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-short-read-'));
            const filePath = path.join(directory, 'events-remote.jsonl');
            const received: Array<{ event: InterInstanceEvent; replayed: boolean }> = [];
            const reader = new FallbackTransport({
                instanceId: 'local',
                onEvent: (event, replayed) => received.push({ event, replayed })
            });
            const readerInternals = reader as unknown as FallbackTransportInternals;
            const originalOpen = fs.promises.open;

            try {
                const historicalEvents = ['中文😀配置A', 'historical-B'].map((key, index): InterInstanceEvent => {
                    if (scenario.mode === 'marked-rewrite') {
                        return {
                            type: 'apiKeyFailoverReset',
                            senderInstanceId: 'remote',
                            timestamp: index + 1,
                            payload: {
                                requestId: key,
                                failureRequestId: `failure-${index}`,
                                requestedBy: 'remote',
                                authorityTerm: 'remote:1',
                                slot: 'openai'
                            }
                        };
                    }
                    return {
                        type: 'configChanged',
                        senderInstanceId: 'remote',
                        timestamp: index + 1,
                        payload: { changedKeys: [key] }
                    };
                });
                const lines = historicalEvents.map(serializeEvent);
                const liveEvent: InterInstanceEvent =
                    scenario.repeatHistoricalLive ?
                        historicalEvents[0]
                    :   {
                            type: 'configChanged',
                            senderInstanceId: 'remote',
                            timestamp: 4,
                            payload: { changedKeys: ['current-live'] }
                        };
                const boundary = '{"gcmpFallbackReplayBoundary":1}\n';
                readerInternals.fileStates.set(filePath, { position: 0, remaining: '' });
                if (scenario.mode !== 'startup') {
                    const padding = serializeEvent({
                        type: 'configChanged',
                        senderInstanceId: 'remote',
                        timestamp: 3,
                        payload: { changedKeys: ['x'.repeat(1024)] }
                    });
                    await fs.promises.writeFile(filePath, lines.join('') + padding, 'utf8');
                    await readerInternals.readNewEvents(filePath);
                    received.length = 0;
                }
                const content =
                    lines.join('') +
                    (scenario.mode === 'marked-rewrite' ? boundary : '') +
                    (scenario.mode !== 'startup' ? serializeEvent(liveEvent) : '');
                await fs.promises.writeFile(filePath, content, 'utf8');

                const emojiStart = Buffer.from(lines[0]).indexOf(Buffer.from('😀'));
                assert.ok(emojiStart >= 0);
                const readLimits =
                    scenario.split === 'none' ? []
                    : scenario.split === 'utf8' ? [emojiStart + 2]
                    : [
                            Buffer.byteLength(lines[0]),
                            Buffer.byteLength(lines[1]) + (scenario.split === 'boundary' ? 12 : 0)
                        ];
                let dataPosition = 0;
                let dataReads = 0;
                let liveAppended = false;
                let shortProbeReads = 0;
                fs.promises.open = async (...args) => {
                    const handle = await originalOpen(...args);
                    if (args[0] === filePath && args[1] === 'r') {
                        const access = handle as unknown as {
                            read: (
                                buffer: Buffer,
                                offset: number,
                                length: number,
                                position: number
                            ) => Promise<{ bytesRead: number; buffer: Buffer }>;
                        };
                        const originalRead = access.read.bind(handle);
                        access.read = async (buffer, offset, length, position) => {
                            if (position !== dataPosition) {
                                const result = await originalRead(
                                    buffer,
                                    offset,
                                    Math.min(length, length <= 64 ? (scenario.probeReadLimit ?? length) : length),
                                    position
                                );
                                if (result.bytesRead < length) {
                                    shortProbeReads += 1;
                                }
                                return result;
                            }
                            const limit = readLimits[dataReads++] ?? length;
                            const result = await originalRead(buffer, offset, Math.min(length, limit), position);
                            dataPosition += result.bytesRead;
                            if (scenario.appendDuringRead && !liveAppended) {
                                liveAppended = true;
                                await fs.promises.appendFile(filePath, serializeEvent(liveEvent), 'utf8');
                            }
                            return result;
                        };
                    }
                    return handle;
                };
                const pendingReads: Promise<void>[] = [];
                const originalReadNewEvents = readerInternals.readNewEvents.bind(reader);
                readerInternals.readNewEvents = (...args) => {
                    const pending = originalReadNewEvents(...args);
                    pendingReads.push(pending);
                    return pending;
                };
                await readerInternals.readNewEvents(filePath, scenario.mode === 'startup');
                for (const pending of pendingReads) {
                    await pending;
                }
                const expected = historicalEvents.map(event => ({ event, replayed: true }));
                if (scenario.mode !== 'startup' || scenario.appendDuringRead) {
                    expected.push({ event: liveEvent, replayed: false });
                }
                assert.deepEqual(received, expected);
                if (scenario.probeReadLimit !== undefined) {
                    assert.ok(shortProbeReads > 0);
                }
                assert.equal(
                    readerInternals.fileStates.get(filePath)?.position,
                    Buffer.byteLength(content) +
                        (scenario.appendDuringRead ? Buffer.byteLength(serializeEvent(liveEvent)) : 0)
                );
                if (scenario.split !== 'none') {
                    assert.ok(dataReads >= 2);
                }
                if (scenario.mode === 'startup' && !scenario.appendDuringRead) {
                    await fs.promises.appendFile(filePath, serializeEvent(liveEvent), 'utf8');
                    await readerInternals.readNewEvents(filePath);
                    assert.deepEqual(received.at(-1), { event: liveEvent, replayed: false });
                }
            } finally {
                fs.promises.open = originalOpen;
                await reader.stop();
                await fs.promises.rm(directory, { recursive: true, force: true });
            }
        });
    }

    for (const truncated of [false, true]) {
        test(`fallback reader rechecks file size after a zero-byte continuity probe: truncated=${truncated}`, async () => {
            const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-probe-eof-'));
            const filePath = path.join(directory, 'events-remote.jsonl');
            const received: Array<{ event: InterInstanceEvent; replayed: boolean }> = [];
            const reader = new FallbackTransport({
                instanceId: 'local',
                onEvent: (event, replayed) => received.push({ event, replayed })
            });
            const readerInternals = reader as unknown as FallbackTransportInternals;
            const originalOpen = fs.promises.open;

            try {
                const history = ['first-history-' + 'x'.repeat(256), 'second-history'].map(
                    (key, index): InterInstanceEvent => ({
                        type: 'configChanged',
                        senderInstanceId: 'remote',
                        timestamp: index + 1,
                        payload: { changedKeys: [key] }
                    })
                );
                const liveEvent: InterInstanceEvent = {
                    type: 'configChanged',
                    senderInstanceId: 'remote',
                    timestamp: 3,
                    payload: { changedKeys: ['live-after-probe'] }
                };
                const lines = history.map(serializeEvent);
                const firstLineLength = Buffer.byteLength(lines[0]);
                const liveLine = serializeEvent(liveEvent);
                assert.ok(Buffer.byteLength(liveLine) < firstLineLength);
                await fs.promises.writeFile(filePath, lines.join(''), 'utf8');
                readerInternals.fileStates.set(filePath, { position: 0, remaining: '' });
                let firstDataRead = true;
                let zeroProbeRead = false;
                fs.promises.open = async (...args) => {
                    const handle = await originalOpen(...args);
                    if (args[0] === filePath && args[1] === 'r') {
                        const access = handle as unknown as {
                            read: (
                                buffer: Buffer,
                                offset: number,
                                length: number,
                                position: number
                            ) => Promise<{ bytesRead: number; buffer: Buffer }>;
                        };
                        const originalRead = access.read.bind(handle);
                        access.read = async (buffer, offset, length, position) => {
                            if (firstDataRead && position === 0) {
                                firstDataRead = false;
                                return await originalRead(buffer, offset, firstLineLength, position);
                            }
                            if (!zeroProbeRead && position === firstLineLength - 64) {
                                zeroProbeRead = true;
                                if (truncated) {
                                    await fs.promises.writeFile(filePath, liveLine, 'utf8');
                                }
                                return { bytesRead: 0, buffer };
                            }
                            return await originalRead(buffer, offset, length, position);
                        };
                    }
                    return handle;
                };
                const pendingReads: Promise<void>[] = [];
                const originalReadNewEvents = readerInternals.readNewEvents.bind(reader);
                readerInternals.readNewEvents = (...args) => {
                    const pending = originalReadNewEvents(...args);
                    pendingReads.push(pending);
                    return pending;
                };
                await readerInternals.readNewEvents(filePath, true);
                for (const pending of pendingReads) {
                    await pending;
                }
                assert.equal(zeroProbeRead, true);
                if (truncated) {
                    assert.deepEqual(received, [
                        { event: history[0], replayed: true },
                        { event: liveEvent, replayed: false }
                    ]);
                    assert.equal(readerInternals.fileStates.get(filePath)?.position, Buffer.byteLength(liveLine));
                } else {
                    assert.deepEqual(received, [{ event: history[0], replayed: true }]);
                    assert.equal(readerInternals.fileStates.get(filePath)?.position, firstLineLength);
                    await readerInternals.readNewEvents(filePath);
                    assert.deepEqual(
                        received,
                        history.map(event => ({ event, replayed: true }))
                    );
                    await fs.promises.appendFile(filePath, liveLine, 'utf8');
                    await readerInternals.readNewEvents(filePath);
                    assert.deepEqual(received.at(-1), { event: liveEvent, replayed: false });
                }
            } finally {
                fs.promises.open = originalOpen;
                await reader.stop();
                await fs.promises.rm(directory, { recursive: true, force: true });
            }
        });
    }

    test('fallback reader bounds consumed event fingerprints and recognizes retained history', async () => {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-history-'));
        const filePath = path.join(directory, 'events-remote.jsonl');
        const received: Array<{ event: InterInstanceEvent; replayed: boolean }> = [];
        const reader = new FallbackTransport({
            instanceId: 'local',
            onEvent: (event, replayed) => received.push({ event, replayed })
        });
        const readerInternals = reader as unknown as FallbackTransportInternals;

        try {
            const events = Array.from(
                { length: 1600 },
                (_, index): InterInstanceEvent => ({
                    type: 'configChanged',
                    senderInstanceId: 'remote',
                    timestamp: index + 1,
                    payload: { changedKeys: [`${index}-${'x'.repeat(1024)}`] }
                })
            );
            await fs.promises.writeFile(filePath, events.map(serializeEvent).join(''), 'utf8');
            readerInternals.fileStates.set(filePath, { position: 0, remaining: '' });
            await readerInternals.readNewEvents(filePath);
            assert.equal(received.length, events.length);
            const state = readerInternals.fileStates.get(filePath);
            const seenEvents = state?.seenEvents;
            const seenBytes = state?.seenEventBytes;
            assert.ok(seenEvents);
            assert.ok(seenBytes !== undefined);
            assert.ok(seenEvents.size < events.length);
            assert.ok([...seenEvents.values()].every(end => end > seenBytes - 1024 * 1024));
            assert.equal(
                seenEvents.has(crypto.createHash('sha256').update(JSON.stringify(events[0])).digest('hex')),
                false
            );
            assert.equal(
                seenEvents.has(
                    crypto
                        .createHash('sha256')
                        .update(JSON.stringify(events.at(-1)))
                        .digest('hex')
                ),
                true
            );

            received.length = 0;
            const retained = events.slice(-2);
            const liveEvent: InterInstanceEvent = {
                type: 'configChanged',
                senderInstanceId: 'remote',
                timestamp: events.length + 1,
                payload: { changedKeys: ['live-after-history-eviction'] }
            };
            await fs.promises.writeFile(filePath, [...retained, liveEvent].map(serializeEvent).join(''), 'utf8');
            await readerInternals.readNewEvents(filePath);
            assert.deepEqual(received, [
                ...retained.map(event => ({ event, replayed: true })),
                { event: liveEvent, replayed: false }
            ]);
        } finally {
            await reader.stop();
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });

    test('fallback reader preserves UTF-8 characters split across reads', async () => {
        const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gcmp-fallback-utf8-'));
        const filePath = path.join(directory, 'events-remote.jsonl');
        const received: InterInstanceEvent[] = [];
        const reader = new FallbackTransport({
            instanceId: 'local',
            onEvent: event => received.push(event)
        });
        const readerInternals = reader as unknown as FallbackTransportInternals;

        try {
            const event: InterInstanceEvent = {
                type: 'configChanged',
                senderInstanceId: 'remote',
                timestamp: 1,
                payload: { changedKeys: ['中文😀配置'] }
            };
            const bytes = Buffer.from(serializeEvent(event));
            const emojiStart = bytes.indexOf(Buffer.from('😀'));
            assert.ok(emojiStart >= 0);
            const splitAt = emojiStart + 2;
            await fs.promises.writeFile(filePath, bytes.subarray(0, splitAt));
            readerInternals.fileStates.set(filePath, { position: 0, remaining: '' });

            await readerInternals.readNewEvents(filePath);
            assert.equal(received.length, 0);

            await fs.promises.appendFile(filePath, bytes.subarray(splitAt));
            await readerInternals.readNewEvents(filePath);

            assert.equal(received.length, 1);
            assert.deepEqual(received[0], event);
        } finally {
            await reader.stop();
            await fs.promises.rm(directory, { recursive: true, force: true });
        }
    });
});
