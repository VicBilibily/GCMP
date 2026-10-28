import * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import { HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER, IMAGE_UNAVAILABLE_PLACEHOLDER } from './imagePlaceholder';

const strippedImageMarker =
    /\[Image was previously shown to you\.(?:\s*Image URI:\s*(vscode-chat-response-resource:\/\/[^\]\s]+))?\]/g;
const imageToolName = /(?:^|[._])view_image$/;
const maxImageBytes = 10 * 1024 * 1024;
const maxRequestImageBytes = 30 * 1024 * 1024;

function isToolCallPart(part: unknown): part is vscode.LanguageModelToolCallPart {
    return (
        typeof part === 'object' &&
        part !== null &&
        'callId' in part &&
        typeof part.callId === 'string' &&
        'name' in part &&
        typeof part.name === 'string' &&
        'input' in part
    );
}

function isToolResultPart(part: unknown): part is vscode.LanguageModelToolResultPart {
    return (
        typeof part === 'object' &&
        part !== null &&
        'callId' in part &&
        typeof part.callId === 'string' &&
        'content' in part &&
        Array.isArray(part.content)
    );
}

function isTextPart(part: unknown): part is vscode.LanguageModelTextPart {
    return (
        typeof part === 'object' &&
        part !== null &&
        'value' in part &&
        typeof part.value === 'string' &&
        !('mimeType' in part)
    );
}

function isToolImageResource(value: string | undefined, callId: string): boolean {
    if (!value) {
        return false;
    }
    try {
        const uri = new URL(value);
        const segments = uri.pathname.split('/');
        return (
            uri.protocol === 'vscode-chat-response-resource:' &&
            !uri.search &&
            !uri.hash &&
            segments.length === 5 &&
            segments[1] === 'tool' &&
            decodeURIComponent(segments[2]) === callId.split('__vscode')[0] &&
            /^\d+$/.test(segments[3]) &&
            /^file\.[a-z0-9]+$/i.test(segments[4])
        );
    } catch {
        return false;
    }
}

function getStrippedImageMarkers(part: unknown, callId: string, imageTool: boolean): RegExpExecArray[] {
    if (!isTextPart(part)) {
        return [];
    }
    return [...part.value.matchAll(strippedImageMarker)].filter(match => {
        if (match[0] === part.value || isToolImageResource(match[1], callId)) {
            return true;
        }
        if (!imageTool) {
            return false;
        }
        const before = part.value[match.index - 1] ?? '';
        const after = part.value[match.index + match[0].length] ?? '';
        return before !== after || !/['"`]/.test(before);
    });
}

function sourceImageUri(part: vscode.LanguageModelToolCallPart): vscode.Uri | undefined {
    if (!imageToolName.test(part.name) || typeof part.input !== 'object' || part.input === null) {
        return undefined;
    }
    const input = part.input as { filePath?: unknown; path?: unknown; absolutePath?: unknown };
    for (const path of [input.filePath, input.path, input.absolutePath]) {
        if (typeof path === 'string' && isAbsolute(path)) {
            return vscode.Uri.file(path);
        }
    }
    return undefined;
}

function detectImageMimeType(data: Uint8Array): string | undefined {
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
        return 'image/jpeg';
    }
    if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
        bytes.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return 'image/webp';
    }
    return undefined;
}

export async function recoverToolResultImages(
    messages: readonly vscode.LanguageModelChatMessage[],
    allowImages: boolean,
    token?: vscode.CancellationToken,
    fileSystem?: Pick<vscode.FileSystem, 'readFile' | 'stat'>
): Promise<vscode.LanguageModelChatMessage[]> {
    const checkCancellation = () => {
        if (token?.isCancellationRequested) {
            throw new vscode.CancellationError();
        }
    };
    checkCancellation();
    const imageCache = new Map<string, vscode.LanguageModelDataPart | undefined>();
    const toolCalls = new Map<string, vscode.LanguageModelToolCallPart[]>();
    let remainingBytes = maxRequestImageBytes;

    const readWithCancellation = async <TResult>(read: () => Thenable<TResult>): Promise<TResult> => {
        checkCancellation();
        if (!token) {
            return read();
        }
        let cancellation: vscode.Disposable | undefined;
        try {
            return await new Promise<TResult>((resolve, reject) => {
                cancellation = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
                checkCancellation();
                Promise.resolve(read()).then(resolve, reject);
            });
        } finally {
            cancellation?.dispose();
        }
    };

    const readImage = async (uri: vscode.Uri): Promise<vscode.LanguageModelDataPart | undefined> => {
        checkCancellation();
        const key = uri.toString();
        if (imageCache.has(key)) {
            return imageCache.get(key);
        }
        imageCache.set(key, undefined);
        try {
            const reader = fileSystem ?? vscode.workspace.fs;
            const stat = await readWithCancellation(() => reader.stat(uri));
            checkCancellation();
            if (!Number.isFinite(stat.size) || stat.size <= 0 || stat.size > Math.min(maxImageBytes, remainingBytes)) {
                return undefined;
            }
            const data = await readWithCancellation(() => reader.readFile(uri));
            checkCancellation();
            if (!(data instanceof Uint8Array) || data.byteLength > Math.min(maxImageBytes, remainingBytes)) {
                return undefined;
            }
            const mimeType = detectImageMimeType(data);
            if (!mimeType) {
                return undefined;
            }
            const image = new vscode.LanguageModelDataPart(data, mimeType);
            imageCache.set(key, image);
            return image;
        } catch {
            checkCancellation();
            return undefined;
        }
    };

    const recovered: vscode.LanguageModelChatMessage[] = [];
    for (const message of messages) {
        checkCancellation();
        if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
            for (const part of message.content) {
                if (isToolCallPart(part)) {
                    const pending = toolCalls.get(part.callId) ?? [];
                    pending.push(part);
                    toolCalls.set(part.callId, pending);
                }
            }
        }
        if (message.role !== vscode.LanguageModelChatMessageRole.User) {
            recovered.push(message);
            continue;
        }
        let changed = false;
        const content: vscode.LanguageModelChatMessage['content'] = [];
        for (const part of message.content) {
            if (!isToolResultPart(part)) {
                content.push(part);
                continue;
            }
            const pending = toolCalls.get(part.callId);
            const call = pending?.shift();
            const fallbackUri = allowImages && call ? sourceImageUri(call) : undefined;
            if (pending?.length === 0) {
                toolCalls.delete(part.callId);
            }
            const parts = part.content.map(item => ({
                item,
                matches: getStrippedImageMarkers(item, part.callId, imageToolName.test(call?.name ?? ''))
            }));
            const markerCount = parts.reduce((count, entry) => count + entry.matches.length, 0);
            if (markerCount === 0) {
                content.push(part);
                continue;
            }
            changed = true;
            const resultContent: vscode.LanguageModelToolResultPart['content'] = [];
            for (const { item, matches } of parts) {
                if (!isTextPart(item) || matches.length === 0) {
                    resultContent.push(item);
                    continue;
                }
                let offset = 0;
                for (const match of matches) {
                    if (match.index > offset) {
                        resultContent.push(new vscode.LanguageModelTextPart(item.value.slice(offset, match.index)));
                    }
                    checkCancellation();
                    let image: vscode.LanguageModelDataPart | undefined;
                    let reread = false;
                    if (allowImages && remainingBytes > 0) {
                        if (match[1]) {
                            try {
                                image = await readImage(vscode.Uri.parse(match[1], true));
                            } catch {
                                checkCancellation();
                            }
                        }
                        if (!image && fallbackUri && markerCount === 1) {
                            image = await readImage(fallbackUri);
                            reread = !!image;
                        }
                    }
                    if (image && image.data.byteLength <= remainingBytes) {
                        remainingBytes -= image.data.byteLength;
                        resultContent.push(
                            new vscode.LanguageModelTextPart(
                                reread ?
                                    '[Image attached from the current source file; it may differ from the previously shown image.]'
                                :   '[Image attached]'
                            ),
                            image
                        );
                    } else {
                        resultContent.push(
                            new vscode.LanguageModelTextPart(
                                allowImages ? HISTORICAL_IMAGE_UNAVAILABLE_PLACEHOLDER : IMAGE_UNAVAILABLE_PLACEHOLDER
                            )
                        );
                    }
                    offset = match.index + match[0].length;
                }
                if (offset < item.value.length) {
                    resultContent.push(new vscode.LanguageModelTextPart(item.value.slice(offset)));
                }
            }
            content.push(
                Object.assign(new vscode.LanguageModelToolResultPart(part.callId, resultContent), part, {
                    content: resultContent
                })
            );
        }
        recovered.push(changed ? { ...message, content } : message);
    }
    return recovered;
}
