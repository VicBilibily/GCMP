import * as path from 'path';

import type { FileDiffSnippet } from './diffSnippetService';

export const OMITTED_NOISY_DIFF_MARKER = '... lockfile/snapshot diff omitted ...';

const SENSITIVE_EXACT_NAMES = new Set(['settings.json', 'keybindings.json', 'launch.json']);
const SENSITIVE_EXTENSIONS = new Set([
    '.pem',
    '.key',
    '.p12',
    '.pfx',
    '.crt',
    '.cer',
    '.csr',
    '.jks',
    '.keystore',
    '.priv'
]);
const SENSITIVE_DOTFILE_PREFIXES = ['.env'];
const SENSITIVE_PATH_SEGMENTS = new Set(['.aws', '.ssh', '.gnupg', '.docker']);
const SENSITIVE_NAME_PATTERNS = ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.secret', '_secret'];

export function normalizeRepoPath(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function escapeRegExp(text: string): string {
    return text.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(pattern: string): RegExp {
    const normalizedPattern = normalizeRepoPath(pattern).toLowerCase();
    let regex = '';

    for (let i = 0; i < normalizedPattern.length; i++) {
        const char = normalizedPattern[i];
        const next = normalizedPattern[i + 1];

        if (char === '*') {
            if (next === '*') {
                regex += '.*';
                i++;
            } else {
                regex += '[^/]*';
            }
            continue;
        }

        if (char === '?') {
            regex += '[^/]';
            continue;
        }

        regex += escapeRegExp(char);
    }

    return new RegExp(`^${regex}$`, 'i');
}

function matchesCustomSensitivePattern(filePath: string, sensitiveFiles: string[]): boolean {
    const normalizedPath = normalizeRepoPath(filePath).toLowerCase();
    const fileName = path.posix.basename(normalizedPath);

    for (const pattern of sensitiveFiles) {
        const normalizedPattern = normalizeRepoPath(pattern).trim();
        if (!normalizedPattern) {
            continue;
        }

        const matcher = globToRegExp(normalizedPattern);
        if (matcher.test(normalizedPath)) {
            return true;
        }

        if (!normalizedPattern.includes('/') && matcher.test(fileName)) {
            return true;
        }
    }

    return false;
}

export function isSensitiveFile(filePath: string, sensitiveFiles: string[]): boolean {
    const normalizedPath = normalizeRepoPath(filePath);
    const pathParts = normalizedPath.split('/').filter(Boolean);
    const fileName = path.posix.basename(normalizedPath);
    const fileNameLower = fileName.toLowerCase();
    const fileExt = path.posix.extname(normalizedPath).toLowerCase();

    if (SENSITIVE_EXACT_NAMES.has(fileNameLower)) {
        return true;
    }

    if (SENSITIVE_EXTENSIONS.has(fileExt) || [...SENSITIVE_EXTENSIONS].some(ext => fileNameLower.endsWith(ext))) {
        return true;
    }

    if (SENSITIVE_DOTFILE_PREFIXES.some(prefix => fileNameLower === prefix || fileNameLower.startsWith(`${prefix}.`))) {
        return true;
    }

    if (pathParts.some(part => SENSITIVE_PATH_SEGMENTS.has(part.toLowerCase()))) {
        return true;
    }

    if (SENSITIVE_NAME_PATTERNS.some(pattern => fileNameLower.includes(pattern))) {
        return true;
    }

    return matchesCustomSensitivePattern(normalizedPath, sensitiveFiles);
}

export function isNoisyGeneratedDiff(filePath: string): boolean {
    const normalizedPath = normalizeRepoPath(filePath).toLowerCase();
    return (
        /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/.test(normalizedPath) ||
        normalizedPath.endsWith('.snap')
    );
}

function buildOmittedDiffExcerpt(excerpt: string, marker: string, maxCharsPerFile: number): string {
    const lines = excerpt.split(/\r?\n/);
    const keptLines: string[] = [];

    for (const line of lines) {
        keptLines.push(line);
        if (line.startsWith('@@ ') || line.startsWith('Binary files ')) {
            break;
        }
    }

    if (keptLines.length === 0) {
        keptLines.push(marker);
    } else if (keptLines[keptLines.length - 1] !== marker) {
        keptLines.push(marker);
    }

    const omitted = keptLines.join('\n');
    return omitted.length > maxCharsPerFile ?
            omitted.slice(0, maxCharsPerFile) + '\n... [file excerpt truncated]'
        :   omitted;
}

export function normalizeDiffExcerpt(filePath: string, excerpt: string, maxCharsPerFile: number): string {
    if (isNoisyGeneratedDiff(filePath)) {
        return buildOmittedDiffExcerpt(excerpt, OMITTED_NOISY_DIFF_MARKER, maxCharsPerFile);
    }

    if (excerpt.length > maxCharsPerFile) {
        return excerpt.slice(0, maxCharsPerFile) + '\n... [file excerpt truncated]';
    }

    return excerpt;
}

export function filterDiffSnippets(
    repoPath: string,
    snippets: FileDiffSnippet[],
    maxCharsPerFile: number,
    sensitiveFiles: string[]
): Array<{ fsPath: string; diff: string }> {
    const entries: Array<{ fsPath: string; diff: string }> = [];

    for (const snip of snippets) {
        const filePath = (snip.filePath ?? '').trim();
        if (!filePath || filePath === '(unknown-file)') {
            continue;
        }

        if (isSensitiveFile(filePath, sensitiveFiles)) {
            continue;
        }

        entries.push({
            fsPath: path.join(repoPath, filePath),
            diff: normalizeDiffExcerpt(filePath, snip.excerpt, maxCharsPerFile)
        });
    }

    return entries;
}
