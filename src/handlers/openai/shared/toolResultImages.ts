import type * as vscode from 'vscode';
import { IMAGE_UNAVAILABLE_PLACEHOLDER, UNSUPPORTED_IMAGE_PLACEHOLDER } from '../../imagePlaceholder';

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
        if (
            !(dataPart.data instanceof Uint8Array) ||
            dataPart.data.byteLength === 0 ||
            typeof dataPart.mimeType !== 'string'
        ) {
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

export function getToolResultImagePlaceholder(
    content: vscode.LanguageModelDataPart,
    allowImages: boolean,
    isImageMimeType: (mimeType: string) => boolean
): string {
    if (!allowImages) {
        return IMAGE_UNAVAILABLE_PLACEHOLDER;
    }
    return extractToolResultImages(content, isImageMimeType).length > 0 ? '[Image]' : UNSUPPORTED_IMAGE_PLACEHOLDER;
}
