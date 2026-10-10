import * as vscode from 'vscode';
import { getAvailableProviders } from '../gcmpServices';
import { t } from './l10n';

const SCHEMA_URI = vscode.Uri.parse('gcmp-fim-settings://root/schema.json');

function schemaContent(): Buffer {
    const { providerIds, enumDescriptions } = getAvailableProviders();
    const providerSchema = {
        type: 'string',
        ...(providerIds.length > 0 ? { enum: providerIds, enumDescriptions } : {})
    };
    return Buffer.from(
        JSON.stringify({
            $schema: 'http://json-schema.org/draft-07/schema#',
            $id: SCHEMA_URI.toString(),
            properties: {
                'gcmp.fimCompletion.modelConfig': {
                    type: 'object',
                    description: t(
                        'FIM (Fill-in-the-Middle) completion mode configuration',
                        'FIM (Fill-in-the-Middle) 补全模式配置'
                    ),
                    properties: {
                        provider: {
                            ...providerSchema,
                            description: t('Provider ID used by FIM completion', 'FIM补全使用的提供商ID')
                        }
                    },
                    additionalProperties: true
                },
                'gcmp.nesCompletion.modelConfig': {
                    type: 'object',
                    description: t(
                        'NES (Next Edit Suggestion) completion mode configuration',
                        'NES (Next Edit Suggestion) 补全模式配置'
                    ),
                    properties: {
                        provider: {
                            ...providerSchema,
                            description: t('Provider ID used by NES completion', 'NES补全使用的提供商ID')
                        }
                    },
                    additionalProperties: true
                }
            }
        }),
        'utf8'
    );
}

export function registerCompletionSchema(): vscode.Disposable & { refresh(): void } {
    const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    const ctime = Date.now();
    let mtime = ctime;
    let disposed = false;
    const refresh = (): void => {
        if (!disposed) {
            mtime = Math.max(Date.now(), mtime + 1);
            emitter.fire([{ type: vscode.FileChangeType.Changed, uri: SCHEMA_URI }]);
        }
    };
    const assertSchemaUri = (uri: vscode.Uri): void => {
        if (
            uri.scheme !== SCHEMA_URI.scheme ||
            uri.authority !== SCHEMA_URI.authority ||
            uri.path !== SCHEMA_URI.path
        ) {
            throw vscode.FileSystemError.FileNotFound(uri);
        }
    };
    const readOnly = (): never => {
        throw vscode.FileSystemError.NoPermissions('gcmp-fim-settings is read-only');
    };
    let registration: vscode.Disposable | undefined;
    try {
        registration = vscode.workspace.registerFileSystemProvider(
            SCHEMA_URI.scheme,
            {
                onDidChangeFile: emitter.event,
                watch: () => new vscode.Disposable(() => {}),
                stat: uri => {
                    assertSchemaUri(uri);
                    return { type: vscode.FileType.File, ctime, mtime, size: schemaContent().byteLength };
                },
                readDirectory: uri => {
                    if (
                        uri.scheme !== SCHEMA_URI.scheme ||
                        uri.authority !== SCHEMA_URI.authority ||
                        (uri.path !== '/' && uri.path !== '')
                    ) {
                        throw vscode.FileSystemError.FileNotFound(uri);
                    }
                    return [['schema.json', vscode.FileType.File]];
                },
                readFile: uri => {
                    assertSchemaUri(uri);
                    return schemaContent();
                },
                createDirectory: readOnly,
                writeFile: readOnly,
                delete: readOnly,
                rename: readOnly
            },
            { isReadonly: true, isCaseSensitive: true }
        );
        const listener = vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('gcmp')) {
                refresh();
            }
        });
        const resources = vscode.Disposable.from(listener, registration, emitter);
        return {
            refresh,
            dispose: () => {
                disposed = true;
                resources.dispose();
            }
        };
    } catch (error) {
        registration?.dispose();
        emitter.dispose();
        throw error;
    }
}
