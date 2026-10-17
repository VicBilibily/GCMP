import { filterExtraBodyParams } from '../shared/extraBody';

export function filterResponsesExtraBodyParams(extraBody: Record<string, unknown>): Record<string, unknown> {
    return filterExtraBodyParams(extraBody, new Set(['model', 'input', 'stream', 'tools']));
}
