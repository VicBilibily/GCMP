import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type * as vscode from 'vscode';
import { HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER, IMAGE_UNAVAILABLE_PLACEHOLDER } from './imagePlaceholder';

class TextPart {
    constructor(public value: string) {}
}

class DataPart {
    constructor(
        public data: Uint8Array,
        public mimeType: string
    ) {}
}

class ToolCallPart {
    constructor(
        public callId: string,
        public name: string,
        public input: object
    ) {}
}

class ToolResultPart {
    constructor(
        public callId: string,
        public content: unknown[]
    ) {}
}

class ThinkingPart extends TextPart {}
class CancellationError extends Error {}

const vscodeMock = {
    LanguageModelChatMessageRole: { Assistant: 'assistant', User: 'user', System: 'system' },
    LanguageModelTextPart: TextPart,
    LanguageModelDataPart: DataPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelThinkingPart: ThinkingPart,
    CancellationError,
    Uri: {
        parse(value: string) {
            return { scheme: new URL(value).protocol.slice(0, -1), toString: () => value };
        },
        file(value: string) {
            return this.parse(pathToFileURL(value).href);
        }
    }
};

const require = createRequire(import.meta.url);
const NodeModule = require('node:module') as { prototype: { require: (id: string) => unknown } };
let recoveryPromise: Promise<typeof import('./toolResultImageRecovery')> | undefined;

function getRecoveryModule() {
    if (!recoveryPromise) {
        const originalRequire = NodeModule.prototype.require;
        NodeModule.prototype.require = function (id: string): unknown {
            if (id === 'vscode') {
                return vscodeMock;
            }
            return originalRequire.call(this, id);
        };
        recoveryPromise = import('./toolResultImageRecovery').finally(() => {
            NodeModule.prototype.require = originalRequire;
        });
    }
    return recoveryPromise;
}

const imageUri = 'vscode-chat-response-resource://review/session/image.png';
const sourcePath = resolve('issue455-source.png');
const sourceUri = pathToFileURL(sourcePath).href;
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const otherPng = Uint8Array.from([...png, 2]);
const marker = (uri = imageUri) => `[Image was previously shown to you. Image URI: ${uri}]`;
const markerWithoutUri = '[Image was previously shown to you.]';

function history(content: unknown[] = [new TextPart(marker())], input: object = { filePath: sourcePath }) {
    return [
        { role: 'assistant', content: [new ToolCallPart('view-1', 'view_image', input)] },
        { role: 'user', content: [new ToolResultPart('view-1', content)] }
    ] as unknown as vscode.LanguageModelChatMessage[];
}

function createFileSystem(files: ReadonlyMap<string, Uint8Array>) {
    const reads: string[] = [];
    const stats: string[] = [];
    const lookup = (uri: vscode.Uri) => {
        const data = files.get(uri.toString());
        if (!data) {
            throw new Error('File not found');
        }
        return data;
    };
    const fileSystem: Pick<vscode.FileSystem, 'stat' | 'readFile'> = {
        async stat(uri) {
            stats.push(uri.toString());
            return { type: 1, size: lookup(uri).byteLength, ctime: 0, mtime: 0 };
        },
        async readFile(uri) {
            reads.push(uri.toString());
            return lookup(uri);
        }
    };
    return { fileSystem, reads, stats };
}

function resultContent(messages: readonly vscode.LanguageModelChatMessage[]) {
    return (messages[1].content[0] as vscode.LanguageModelToolResultPart).content;
}

function createCancellationToken() {
    let cancelled = false;
    const listeners = new Set<(event: undefined) => unknown>();
    const token: vscode.CancellationToken = {
        get isCancellationRequested() {
            return cancelled;
        },
        onCancellationRequested(listener) {
            listeners.add(listener);
            return {
                dispose: () => {
                    listeners.delete(listener);
                }
            };
        }
    };
    return {
        token,
        listeners,
        cancel() {
            cancelled = true;
            for (const listener of [...listeners]) {
                listener(undefined);
            }
        }
    };
}

function deferred<TValue>() {
    let resolve!: (value: TValue | PromiseLike<TValue>) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<TValue>((resolveValue, rejectValue) => {
        resolve = resolveValue;
        reject = rejectValue;
    });
    return { promise, resolve, reject };
}

test('history recovery prefers the original resource and leaves input history unchanged', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(
        new Map([
            [imageUri, png],
            [sourceUri, otherPng]
        ])
    );
    const before = new TextPart('before ');
    const after = new TextPart(' after');
    const messages = history([before, new TextPart(marker()), after]);
    const snapshot = JSON.stringify(messages);
    const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
    assert.deepEqual(fixture.reads, [imageUri]);
    assert.deepEqual(
        resultContent(recovered).filter(part => part instanceof DataPart),
        [new DataPart(png, 'image/png')]
    );
    const text = resultContent(recovered)
        .filter(part => part instanceof TextPart)
        .map(part => part.value)
        .join('');
    assert.match(text, /^before /);
    assert.match(text, / after$/);
    assert.equal(resultContent(recovered)[0], before);
    assert.equal(resultContent(recovered).at(-1), after);
    assert.doesNotMatch(text, /previously shown/);
    assert.equal(JSON.stringify(messages), snapshot);
    assert.ok(recovered[1].content[0] instanceof ToolResultPart);
});

test('history recovery falls back to the matching image tool file and identifies a reread', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[sourceUri, png]]));
    const recovered = await recoverToolResultImages(history(), true, undefined, fixture.fileSystem);
    assert.deepEqual(fixture.reads, [sourceUri]);
    assert.deepEqual(
        resultContent(recovered).filter(part => part instanceof DataPart),
        [new DataPart(png, 'image/png')]
    );
    assert.match(
        resultContent(recovered)
            .filter(part => part instanceof TextPart)
            .map(part => part.value)
            .join(''),
        /current source file/
    );
});

test('unrecoverable historical images receive an explicit warning instead of a shown marker', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map());
    const recovered = await recoverToolResultImages(history(), true, undefined, fixture.fileSystem);
    assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
});

test('non-vision requests replace historical markers without reading image files', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, png]]));
    const recovered = await recoverToolResultImages(history(), false, undefined, fixture.fileSystem);
    assert.deepEqual(fixture.stats, []);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(resultContent(recovered), [new TextPart(IMAGE_UNAVAILABLE_PLACEHOLDER)]);
});

for (const allowImages of [false, true]) {
    for (const sourceAvailable of [false, true]) {
        test(`URI-less historical markers are handled: vision=${allowImages}, source=${sourceAvailable}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const fixture = createFileSystem(new Map(sourceAvailable ? [[sourceUri, png]] : []));
            const messages = history([new TextPart(markerWithoutUri)]);
            const snapshot = JSON.stringify(messages);
            const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
            if (allowImages && sourceAvailable) {
                assert.deepEqual(
                    resultContent(recovered).filter(part => part instanceof DataPart),
                    [new DataPart(png, 'image/png')]
                );
                assert.match((resultContent(recovered)[0] as TextPart).value, /current source file/);
                assert.deepEqual(fixture.reads, [sourceUri]);
            } else {
                assert.deepEqual(resultContent(recovered), [
                    new TextPart(allowImages ? HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER : IMAGE_UNAVAILABLE_PLACEHOLDER)
                ]);
                assert.deepEqual(fixture.reads, []);
            }
            assert.deepEqual(fixture.stats, allowImages ? [sourceUri] : []);
            assert.equal(JSON.stringify(messages), snapshot);
        });
    }
}

test('ordinary tool results and current binary images retain their original objects', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map());
    const messages = history([new TextPart('result'), new DataPart(png, 'image/png')]);
    const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
    assert.equal(recovered[0], messages[0]);
    assert.equal(recovered[1], messages[1]);
    assert.deepEqual(fixture.stats, []);
});

for (const markerHasUri of [false, true]) {
    const markerText = markerHasUri ? marker() : markerWithoutUri;
    for (const [scenario, text] of [
        ['source', `const marker = '${markerText}';`],
        ['log', `before\n${markerText}\nafter`],
        ['trailing-newline', `${markerText}\n`],
        ['joined-markers', `${markerText} ${markerText}`]
    ] as const) {
        for (const allowImages of [false, true]) {
            test(`literal markers preserve ${scenario}: URI=${markerHasUri}, vision=${allowImages}`, async () => {
                const { recoverToolResultImages } = await getRecoveryModule();
                const fixture = createFileSystem(
                    new Map([
                        [imageUri, png],
                        [sourceUri, otherPng]
                    ])
                );
                const textPart = Object.freeze(new TextPart(text));
                const messages = history([textPart]);
                (messages[0].content[0] as vscode.LanguageModelToolCallPart).name = 'read_file';
                const snapshot = JSON.stringify(messages);
                const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
                assert.equal(recovered[0], messages[0]);
                assert.equal(recovered[1], messages[1]);
                assert.equal(resultContent(recovered)[0], textPart);
                assert.deepEqual(fixture.stats, []);
                assert.deepEqual(fixture.reads, []);
                assert.equal(JSON.stringify(messages), snapshot);
            });
        }
    }
}

for (const allowImages of [false, true]) {
    test(`literal markers do not prevent a separate image part from recovering: vision=${allowImages}`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map([[sourceUri, png]]));
        const literal = new TextPart(`const marker = '${marker()}';`);
        const messages = history([literal, new TextPart(markerWithoutUri)]);
        const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
        const content = resultContent(recovered);
        assert.equal(content[0], literal);
        if (allowImages) {
            assert.deepEqual(
                content.filter(part => part instanceof DataPart),
                [new DataPart(png, 'image/png')]
            );
            assert.match((content[1] as TextPart).value, /current source file/);
            assert.deepEqual(fixture.stats, [sourceUri]);
            assert.deepEqual(fixture.reads, [sourceUri]);
        } else {
            assert.deepEqual(content, [literal, new TextPart(IMAGE_UNAVAILABLE_PLACEHOLDER)]);
            assert.deepEqual(fixture.stats, []);
            assert.deepEqual(fixture.reads, []);
        }
    });
}

for (const markerHasUri of [false, true]) {
    const firstMarker = markerHasUri ? marker() : markerWithoutUri;
    const secondMarker = markerHasUri ? marker(`${imageUri}-second`) : markerWithoutUri;
    for (const [scenario, text, imageCount] of [
        ['caption', `Screenshot follows\n${firstMarker}\nEnd of screenshot`, 1],
        ['inline-caption', `Screenshot: ${firstMarker} end`, 1],
        ['multiple', `${firstMarker}${secondMarker}`, 2],
        ['trailing-newline', `${firstMarker}\n`, 1]
    ] as const) {
        for (const allowImages of [false, true]) {
            test(`merged image history recovers ${scenario}: URI=${markerHasUri}, vision=${allowImages}`, async () => {
                const { recoverToolResultImages } = await getRecoveryModule();
                const fixture = createFileSystem(
                    new Map([
                        [imageUri, png],
                        [`${imageUri}-second`, otherPng],
                        [sourceUri, png]
                    ])
                );
                const messages = history([Object.freeze(new TextPart(text))]);
                const snapshot = JSON.stringify(messages);
                const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
                const content = resultContent(recovered);
                const expectedImages =
                    !allowImages || (!markerHasUri && imageCount > 1) ? []
                    : imageCount === 2 ? [new DataPart(png, 'image/png'), new DataPart(otherPng, 'image/png')]
                    : [new DataPart(png, 'image/png')];
                assert.deepEqual(
                    content.filter(part => part instanceof DataPart),
                    expectedImages
                );
                const replacement =
                    !allowImages ? IMAGE_UNAVAILABLE_PLACEHOLDER
                    : expectedImages.length === 0 ? HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER
                    : markerHasUri ? '[Image attached]'
                    : '[Image attached from the current source file; it may differ from the previously shown image.]';
                assert.equal(
                    content
                        .filter(part => part instanceof TextPart)
                        .map(part => part.value)
                        .join(''),
                    text.replace(firstMarker, replacement).replace(secondMarker, replacement)
                );
                if (!allowImages || (!markerHasUri && imageCount > 1)) {
                    assert.deepEqual(fixture.stats, []);
                    assert.deepEqual(fixture.reads, []);
                }
                assert.equal(JSON.stringify(messages), snapshot);
            });
        }
    }
}

const toolImageUri = 'vscode-chat-response-resource://review/tool/view-1/0/file.png';
for (const [source, toolName, uri] of [
    ['bound-resource', 'capture_screenshot', toolImageUri],
    ['bound-image-tool', 'view_image', toolImageUri],
    ['legacy-resource', 'view_image', imageUri],
    ['without-uri', 'view_image', undefined]
] as const) {
    for (const quote of ["'", '"', '`']) {
        const markerText = uri ? marker(uri) : markerWithoutUri;
        for (const [boundary, text] of [
            ['prefix', `Screenshot saved as ${quote}screen.png${quote}${markerText}`],
            ['suffix', `${markerText}${quote}screen.png${quote} screenshot`],
            ['wrapped', `${quote}${markerText}${quote}`]
        ] as const) {
            for (const allowImages of [false, true]) {
                test(`quoted image boundary: ${source}, ${boundary}, quote=${quote}, vision=${allowImages}`, async () => {
                    const { recoverToolResultImages } = await getRecoveryModule();
                    const fixture = createFileSystem(
                        new Map([
                            [toolImageUri, png],
                            [imageUri, png],
                            [sourceUri, otherPng]
                        ])
                    );
                    const textPart = Object.freeze(new TextPart(text));
                    const messages = history([textPart]);
                    (messages[0].content[0] as vscode.LanguageModelToolCallPart).name = toolName;
                    const snapshot = JSON.stringify(messages);
                    const recovered = await recoverToolResultImages(
                        messages,
                        allowImages,
                        undefined,
                        fixture.fileSystem
                    );
                    const content = resultContent(recovered);
                    const recognized = uri === toolImageUri || boundary !== 'wrapped';
                    assert.deepEqual(
                        content.filter(part => part instanceof DataPart),
                        recognized && allowImages ? [new DataPart(uri ? png : otherPng, 'image/png')] : []
                    );
                    if (recognized) {
                        const replacement =
                            !allowImages ? IMAGE_UNAVAILABLE_PLACEHOLDER
                            : uri ? '[Image attached]'
                            : '[Image attached from the current source file; it may differ from the previously shown image.]';
                        assert.equal(
                            content
                                .filter(part => part instanceof TextPart)
                                .map(part => part.value)
                                .join(''),
                            text.replace(markerText, replacement)
                        );
                    } else {
                        assert.equal(recovered[1], messages[1]);
                        assert.equal(content[0], textPart);
                    }
                    assert.deepEqual(fixture.stats, recognized && allowImages ? [uri ?? sourceUri] : []);
                    assert.deepEqual(fixture.reads, recognized && allowImages ? [uri ?? sourceUri] : []);
                    assert.equal(JSON.stringify(messages), snapshot);
                });
            }
        }
    }
}

for (const [scenario, uri, callId, recognized] of [
    ['matching-call', toolImageUri, 'view-1', true],
    ['normalized-call', toolImageUri, 'view-1__vscode_2', true],
    ['other-call', toolImageUri, 'view-10', false],
    ['malformed-call', toolImageUri.replace('/view-1/', '/%GG/'), 'view-1', false],
    ['invalid-index', toolImageUri.replace('/0/', '/invalid/'), 'view-1', false],
    ['wrong-kind', toolImageUri.replace('/tool/', '/other/'), 'view-1', false],
    ['extra-path', `${toolImageUri}/extra`, 'view-1', false],
    ['query', `${toolImageUri}?source=other`, 'view-1', false],
    ['fragment', `${toolImageUri}#other`, 'view-1', false]
] as const) {
    for (const allowImages of [false, true]) {
        test(`merged resource provenance: ${scenario}, vision=${allowImages}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const fixture = createFileSystem(
                new Map([
                    [uri, png],
                    [sourceUri, otherPng]
                ])
            );
            const text = `Screenshot follows\n${marker(uri)}\nEnd of screenshot`;
            const textPart = Object.freeze(new TextPart(text));
            const messages = history([textPart]);
            const call = messages[0].content[0] as vscode.LanguageModelToolCallPart;
            call.name = 'capture_screenshot';
            call.callId = callId;
            (messages[1].content[0] as vscode.LanguageModelToolResultPart).callId = callId;
            const snapshot = JSON.stringify(messages);
            const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
            const content = resultContent(recovered);
            assert.deepEqual(
                content.filter(part => part instanceof DataPart),
                recognized && allowImages ? [new DataPart(png, 'image/png')] : []
            );
            if (recognized) {
                assert.equal(
                    content
                        .filter(part => part instanceof TextPart)
                        .map(part => part.value)
                        .join(''),
                    text.replace(marker(uri), allowImages ? '[Image attached]' : IMAGE_UNAVAILABLE_PLACEHOLDER)
                );
            } else {
                assert.equal(recovered[1], messages[1]);
                assert.equal(content[0], textPart);
            }
            assert.deepEqual(fixture.stats, recognized && allowImages ? [uri] : []);
            assert.deepEqual(fixture.reads, recognized && allowImages ? [uri] : []);
            assert.equal(JSON.stringify(messages), snapshot);
        });
    }
}

test('expired merged resources from other tools do not fall back to their file arguments', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[sourceUri, png]]));
    const text = `Screenshot: ${marker(toolImageUri)}`;
    const messages = history([new TextPart(text)]);
    (messages[0].content[0] as vscode.LanguageModelToolCallPart).name = 'capture_screenshot';
    const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
    assert.deepEqual(fixture.stats, [toolImageUri]);
    assert.deepEqual(fixture.reads, []);
    assert.equal(resultContent(recovered).filter(part => part instanceof DataPart).length, 0);
    assert.equal(
        resultContent(recovered)
            .filter(part => part instanceof TextPart)
            .map(part => part.value)
            .join(''),
        text.replace(marker(toolImageUri), HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)
    );
});

for (const quote of ["'", '"', '`']) {
    for (const allowImages of [false, true]) {
        test(`merged literal remains intact beside a real image: quote=${quote}, vision=${allowImages}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const fixture = createFileSystem(new Map([[sourceUri, png]]));
            const literal = `const marker = ${quote}${markerWithoutUri}${quote};\nScreenshot: `;
            const messages = history([new TextPart(`${literal}${markerWithoutUri}`)]);
            const recovered = await recoverToolResultImages(messages, allowImages, undefined, fixture.fileSystem);
            const content = resultContent(recovered);
            assert.deepEqual(
                content.filter(part => part instanceof DataPart),
                allowImages ? [new DataPart(png, 'image/png')] : []
            );
            const replacement =
                allowImages ?
                    '[Image attached from the current source file; it may differ from the previously shown image.]'
                :   IMAGE_UNAVAILABLE_PLACEHOLDER;
            assert.equal(
                content
                    .filter(part => part instanceof TextPart)
                    .map(part => part.value)
                    .join(''),
                `${literal}${replacement}`
            );
            assert.deepEqual(fixture.stats, allowImages ? [sourceUri] : []);
            assert.deepEqual(fixture.reads, allowImages ? [sourceUri] : []);
        });
    }
}

for (const field of ['filePath', 'path', 'absolutePath']) {
    test(`view_image fallback supports the ${field} argument`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map([[sourceUri, png]]));
        const recovered = await recoverToolResultImages(
            history(undefined, { [field]: sourcePath }),
            true,
            undefined,
            fixture.fileSystem
        );
        assert.deepEqual(
            resultContent(recovered).filter(part => part instanceof DataPart),
            [new DataPart(png, 'image/png')]
        );
    });
}

for (const [mimeType, signature] of [
    ['image/png', png],
    ['image/jpeg', Uint8Array.from([255, 216, 255, 224])],
    ['image/gif', new TextEncoder().encode('GIF87a')],
    ['image/gif', new TextEncoder().encode('GIF89a')],
    ['image/webp', new TextEncoder().encode('RIFF0000WEBP')]
] as const) {
    test(`recovery sniffs ${mimeType} from file bytes instead of the filename`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map([[imageUri, signature]]));
        const recovered = await recoverToolResultImages(history(), true, undefined, fixture.fileSystem);
        assert.deepEqual(
            resultContent(recovered).filter(part => part instanceof DataPart),
            [new DataPart(signature, mimeType)]
        );
    });
}

test('recovery rejects non-image bytes even when the source is named PNG', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, new TextEncoder().encode('not an image')]]));
    const recovered = await recoverToolResultImages(history(undefined, {}), true, undefined, fixture.fileSystem);
    assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
});

test('oversized source metadata is rejected before reading bytes', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, png]]));
    const fileSystem = {
        ...fixture.fileSystem,
        async stat(uri: vscode.Uri) {
            return { ...(await fixture.fileSystem.stat(uri)), size: 10 * 1024 * 1024 + 1 };
        }
    };
    const recovered = await recoverToolResultImages(history(undefined, {}), true, undefined, fileSystem);
    assert.deepEqual(fixture.reads, []);
    assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
});

test('size is checked again when the file grows between stat and read', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, png]]));
    const grownData = new Uint8Array(10 * 1024 * 1024 + 1);
    grownData.set(png);
    const recovered = await recoverToolResultImages(history(undefined, {}), true, undefined, {
        ...fixture.fileSystem,
        async readFile() {
            return grownData;
        }
    });
    assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
});

for (const merged of [false, true]) {
    test(`repeated references count against the request image budget: merged=${merged}`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const largeImage = new Uint8Array(10 * 1024 * 1024);
        largeImage.set(png);
        const fixture = createFileSystem(new Map([[imageUri, largeImage]]));
        const recovered = await recoverToolResultImages(
            history(
                merged ? [new TextPart(marker().repeat(4))] : Array.from({ length: 4 }, () => new TextPart(marker()))
            ),
            true,
            undefined,
            fixture.fileSystem
        );
        const content = resultContent(recovered);
        assert.equal(content.filter(part => part instanceof DataPart).length, 3);
        assert.equal(
            content.filter(part => part instanceof TextPart && part.value === HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)
                .length,
            1
        );
        assert.deepEqual(fixture.reads, [imageUri]);
    });
}

test('resource caches are scoped to one request rather than leaking into another session', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const first = createFileSystem(new Map([[imageUri, png]]));
    const second = createFileSystem(new Map([[imageUri, otherPng]]));
    await recoverToolResultImages(history(), true, undefined, first.fileSystem);
    const recovered = await recoverToolResultImages(history(), true, undefined, second.fileSystem);
    assert.deepEqual(first.reads, [imageUri]);
    assert.deepEqual(second.reads, [imageUri]);
    assert.deepEqual(
        resultContent(recovered).filter(part => part instanceof DataPart),
        [new DataPart(otherPng, 'image/png')]
    );
});

for (const parallel of [false, true]) {
    test(`reused call IDs recover the matching file in invocation order: parallel=${parallel}`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const secondPath = resolve('issue455-second.png');
        const fixture = createFileSystem(
            new Map([
                [sourceUri, png],
                [pathToFileURL(secondPath).href, otherPng]
            ])
        );
        const calls = [
            new ToolCallPart('reused', 'view_image', { filePath: sourcePath }),
            new ToolCallPart('reused', 'view_image', { filePath: secondPath })
        ];
        const outputs = calls.map(call => new ToolResultPart(call.callId, [new TextPart(marker())]));
        const messages =
            parallel ?
                [
                    { role: 'assistant', content: calls },
                    { role: 'user', content: outputs }
                ]
            :   calls.flatMap((call, index) => [
                    { role: 'assistant', content: [call] },
                    { role: 'user', content: [outputs[index]] }
                ]);
        const recovered = await recoverToolResultImages(messages as never, true, undefined, fixture.fileSystem);
        const images = recovered
            .flatMap(message => message.content)
            .filter(part => part instanceof ToolResultPart)
            .flatMap(part => part.content)
            .filter(part => part instanceof DataPart);
        assert.deepEqual(images, [new DataPart(png, 'image/png'), new DataPart(otherPng, 'image/png')]);
    });
}

for (const [scenario, markers] of [
    ['with-uri', [marker(), marker(`${imageUri}-other`)]],
    ['without-uri', [markerWithoutUri, markerWithoutUri]],
    ['mixed', [marker(), markerWithoutUri]]
] as const) {
    for (const merged of [false, true]) {
        test(`one source file cannot replace several historical images: ${scenario}, merged=${merged}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const fixture = createFileSystem(new Map([[sourceUri, png]]));
            const messages = history(
                merged ? [new TextPart(markers.join(''))] : markers.map(value => new TextPart(value))
            );
            const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
            assert.deepEqual(fixture.reads, []);
            assert.ok(!fixture.stats.includes(sourceUri));
            assert.equal(resultContent(recovered).filter(part => part instanceof DataPart).length, 0);
            assert.equal(
                resultContent(recovered).filter(
                    part => part instanceof TextPart && part.value === HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER
                ).length,
                2
            );
        });
    }
}

for (const scenario of ['relative-path', 'unrelated-tool', 'orphan-result']) {
    test(`file fallback is not allowed for ${scenario}`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map([[sourceUri, png]]));
        const messages = history(undefined, { filePath: scenario === 'relative-path' ? 'relative.png' : sourcePath });
        if (scenario === 'unrelated-tool') {
            (messages[0].content[0] as vscode.LanguageModelToolCallPart).name = 'read_file';
        }
        if (scenario === 'orphan-result') {
            messages[0].content = [];
        }
        const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
        assert.deepEqual(fixture.reads, []);
        assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
    });
}

test('serialized tool-result parts recover without losing metadata or mutating frozen inputs', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, png]]));
    const text = Object.freeze({ value: marker() });
    const toolResult = Object.freeze({ callId: 'view-1', content: Object.freeze([text]), testMetadata: 'preserved' });
    const messages = Object.freeze([
        Object.freeze({ role: 'user', content: Object.freeze([toolResult]) })
    ]) as unknown as readonly vscode.LanguageModelChatMessage[];
    const recovered = await recoverToolResultImages(messages, true, undefined, fixture.fileSystem);
    const result = recovered[0].content[0] as vscode.LanguageModelToolResultPart & { testMetadata: string };
    assert.ok(result instanceof ToolResultPart);
    assert.equal(result.testMetadata, 'preserved');
    assert.deepEqual(
        result.content.filter(part => part instanceof DataPart),
        [new DataPart(png, 'image/png')]
    );
    assert.equal(text.value, marker());
});

for (const stage of ['before', 'stat', 'read']) {
    test(`cancellation at ${stage} stops image recovery without falling back`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(
            new Map([
                [imageUri, png],
                [sourceUri, otherPng]
            ])
        );
        const cancellation = createCancellationToken();
        if (stage === 'before') {
            cancellation.cancel();
        }
        const fileSystem = {
            async stat(uri: vscode.Uri) {
                const result = await fixture.fileSystem.stat(uri);
                if (stage === 'stat') {
                    cancellation.cancel();
                }
                return result;
            },
            async readFile(uri: vscode.Uri) {
                const result = await fixture.fileSystem.readFile(uri);
                if (stage === 'read') {
                    cancellation.cancel();
                }
                return result;
            }
        };
        await assert.rejects(
            recoverToolResultImages(history(), true, cancellation.token, fileSystem),
            CancellationError
        );
        assert.deepEqual(fixture.reads, stage === 'read' ? [imageUri] : []);
        assert.deepEqual(fixture.stats, stage === 'before' ? [] : [imageUri]);
        assert.equal(cancellation.listeners.size, 0);
    });
}

for (const stage of ['stat', 'readFile']) {
    for (const lateFailure of [false, true]) {
        test(`cancellation settles pending ${stage} before I/O completes: lateFailure=${lateFailure}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const fixture = createFileSystem(
                new Map([
                    [imageUri, png],
                    [sourceUri, otherPng]
                ])
            );
            const cancellation = createCancellationToken();
            const started = deferred<void>();
            const blocked = deferred<void>();
            const fileSystem: Pick<vscode.FileSystem, 'stat' | 'readFile'> = {
                async stat(uri) {
                    const result = await fixture.fileSystem.stat(uri);
                    if (stage === 'stat') {
                        started.resolve();
                        await blocked.promise;
                    }
                    return result;
                },
                async readFile(uri) {
                    const result = await fixture.fileSystem.readFile(uri);
                    if (stage === 'readFile') {
                        started.resolve();
                        await blocked.promise;
                    }
                    return result;
                }
            };
            let outcome = 'pending';
            const recovery = recoverToolResultImages(history(), true, cancellation.token, fileSystem).then(
                () => {
                    outcome = 'resolved';
                },
                error => {
                    outcome = error instanceof CancellationError ? 'cancelled' : 'failed';
                }
            );
            await started.promise;
            const activeListeners = cancellation.listeners.size;
            cancellation.cancel();
            await nextTurn();
            const afterCancellation = outcome;
            const remainingListeners = cancellation.listeners.size;
            if (lateFailure) {
                blocked.reject(new Error('Late I/O failure'));
            } else {
                blocked.resolve();
            }
            await recovery;
            await nextTurn();
            assert.equal(afterCancellation, 'cancelled');
            assert.equal(activeListeners, 1);
            assert.equal(remainingListeners, 0);
            assert.deepEqual(fixture.stats, [imageUri]);
            assert.deepEqual(fixture.reads, stage === 'readFile' ? [imageUri] : []);
        });
    }
}

for (const sourceAvailable of [false, true]) {
    test(`recovery disposes cancellation listeners after normal I/O: source=${sourceAvailable}`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map(sourceAvailable ? [[imageUri, png]] : []));
        const cancellation = createCancellationToken();
        const recovered = await recoverToolResultImages(
            history(undefined, {}),
            true,
            cancellation.token,
            fixture.fileSystem
        );
        assert.equal(cancellation.listeners.size, 0);
        assert.equal(
            resultContent(recovered).some(part => part instanceof DataPart),
            sourceAvailable
        );
        cancellation.cancel();
        await nextTurn();
    });
}

test('cancellation during subscription prevents I/O and disposes the listener', async () => {
    const { recoverToolResultImages } = await getRecoveryModule();
    const fixture = createFileSystem(new Map([[imageUri, png]]));
    const cancellation = createCancellationToken();
    const token: vscode.CancellationToken = {
        get isCancellationRequested() {
            return cancellation.token.isCancellationRequested;
        },
        onCancellationRequested(listener) {
            const disposable = cancellation.token.onCancellationRequested(listener);
            cancellation.cancel();
            return disposable;
        }
    };
    await assert.rejects(recoverToolResultImages(history(), true, token, fixture.fileSystem), CancellationError);
    assert.deepEqual(fixture.stats, []);
    assert.deepEqual(fixture.reads, []);
    assert.equal(cancellation.listeners.size, 0);
});

for (const stage of ['stat', 'readFile']) {
    test(`synchronous ${stage} failures release cancellation listeners`, async () => {
        const { recoverToolResultImages } = await getRecoveryModule();
        const fixture = createFileSystem(new Map([[imageUri, png]]));
        const cancellation = createCancellationToken();
        const fileSystem: Pick<vscode.FileSystem, 'stat' | 'readFile'> = {
            stat(uri) {
                if (stage === 'stat') {
                    throw new Error('Synchronous stat failure');
                }
                return fixture.fileSystem.stat(uri);
            },
            readFile() {
                throw new Error('Synchronous read failure');
            }
        };
        const recovered = await recoverToolResultImages(history(undefined, {}), true, cancellation.token, fileSystem);
        assert.deepEqual(resultContent(recovered), [new TextPart(HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER)]);
        assert.equal(cancellation.listeners.size, 0);
    });
}

async function loadConverters() {
    const originalRequire = NodeModule.prototype.require;
    NodeModule.prototype.require = function (id: string): unknown {
        if (id === 'vscode') {
            return vscodeMock;
        }
        if (id.endsWith('/utils/runtime/logger')) {
            return { Logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } };
        }
        return originalRequire.call(this, id);
    };
    try {
        return {
            ...(await import('./openai/openaiResponsesMessageConverter')),
            ...(await import('./openai/openaiResponsesRequestBuilder')),
            ...(await import('./openai/chat/messageConverter')),
            ...(await import('./openai/shared/images')),
            ...(await import('./anthropic/anthropicConverter'))
        };
    } finally {
        NodeModule.prototype.require = originalRequire;
    }
}

let convertersPromise: ReturnType<typeof loadConverters> | undefined;
for (const [protocol, markerHasUri] of [
    ['responses', true],
    ['chat', true],
    ['anthropic', true],
    ['responses', false],
    ['chat', false],
    ['anthropic', false]
] as const) {
    for (const imageInput of [false, true]) {
        test(`recovered history reaches ${protocol} with vision=${imageInput}, URI=${markerHasUri}`, async () => {
            const { recoverToolResultImages } = await getRecoveryModule();
            const modules = await (convertersPromise ??= loadConverters());
            const resourceUri = markerHasUri ? imageUri : sourceUri;
            const fixture = createFileSystem(new Map([[resourceUri, png]]));
            const messages = await recoverToolResultImages(
                history([new TextPart(markerHasUri ? marker() : markerWithoutUri)]),
                imageInput,
                undefined,
                fixture.fileSystem
            );
            const modelConfig = { id: 'vision-test', provider: 'review', capabilities: { imageInput } };
            let serialized: string;
            if (protocol === 'responses') {
                const converter = new modules.OpenAIResponsesMessageConverter(modules.openAIImages, 'Review');
                const builder = new modules.OpenAIResponsesRequestBuilder('Review', converter, 'review');
                const { requestBody } = builder.build({
                    model: { id: 'vision-test', name: 'Review' } as never,
                    modelConfig: modelConfig as never,
                    messages,
                    options: {} as never,
                    sessionId: 'review-session'
                });
                assert.equal(requestBody.previous_response_id, undefined);
                serialized = JSON.stringify(requestBody.input);
            } else if (protocol === 'chat') {
                serialized = JSON.stringify(
                    new modules.OpenAIChatMessageConverter({ provider: 'review' }).convertMessagesToOpenAI(
                        messages,
                        modelConfig as never
                    )
                );
            } else {
                serialized = JSON.stringify(modules.apiMessageToAnthropicMessage(modelConfig as never, messages));
            }
            assert.doesNotMatch(serialized, /Image was previously shown to you/);
            if (imageInput) {
                assert.match(serialized, /"type":"(?:input_image|image_url|image)"/);
                assert.ok(serialized.includes(Buffer.from(png).toString('base64')));
                assert.deepEqual(fixture.reads, [resourceUri]);
            } else {
                assert.doesNotMatch(serialized, /"type":"(?:input_image|image_url|image)"/);
                assert.ok(serialized.includes(IMAGE_UNAVAILABLE_PLACEHOLDER));
                assert.deepEqual(fixture.reads, []);
            }
        });
    }
}
