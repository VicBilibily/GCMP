import type * as vscode from 'vscode';

const supportedToolImageMimeTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function extractToolResultImages(
    content: unknown,
    isImageMimeType: (mimeType: string) => boolean
): vscode.LanguageModelDataPart[] {
    const parts = Array.isArray(content) ? content : [content];
    const images: vscode.LanguageModelDataPart[] = [];

    for (const part of parts) {
        if (typeof part !== 'object' || part === null || !('data' in part) || !('mimeType' in part)) {
            continue;
        }

        const dataPart = part as { data: unknown; mimeType: unknown };
        if (!(dataPart.data instanceof Uint8Array) || typeof dataPart.mimeType !== 'string') {
            continue;
        }

        const normalizedMimeType = dataPart.mimeType.toLowerCase().trim();
        const mimeType = normalizedMimeType === 'image/jpg' ? 'image/jpeg' : normalizedMimeType;
        if (!supportedToolImageMimeTypes.has(mimeType) || !isImageMimeType(mimeType)) {
            continue;
        }

        images.push(
            mimeType === dataPart.mimeType ?
                (dataPart as vscode.LanguageModelDataPart)
            :   { data: dataPart.data, mimeType }
        );
    }

    return images;
}
