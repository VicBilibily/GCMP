import * as vscode from 'vscode';
import { OffsetRange } from '@vscode/chat-lib/dist/src/_internal/util/vs/editor/common/core/ranges/offsetRange';
import { Logger } from '../utils';
import {
    MutableObservableDocument,
    MutableObservableWorkspace
} from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/observableWorkspace';
import { StringText } from '@vscode/chat-lib/dist/src/_internal/util/vs/editor/common/core/text/abstractText';
import { DocumentId } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/dataTypes/languageId';
import { URI } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/uri';

/**
 * VS Code 文档到 ObservableWorkspace 的适配器
 * 管理 MutableObservableWorkspace 和文档同步
 */
export class WorkspaceAdapter implements vscode.Disposable {
    private readonly workspace: MutableObservableWorkspace;
    private readonly documentMap = new Map<string, MutableObservableDocument>();
    private readonly disposables: vscode.Disposable[] = [];

    private pendingDocumentChanges = new Set<string>();
    private documentChangeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor() {
        this.workspace = new MutableObservableWorkspace();

        // // 监听文档变化
        // this.disposables.push(
        //     vscode.workspace.onDidChangeTextDocument(() => {
        //         // 不在此处处理文档变化，触发提示前自动同步
        //     })
        // );

        // 监听文档打开
        this.disposables.push(
            vscode.workspace.onDidOpenTextDocument(doc => {
                this.syncDocument(doc);
            })
        );

        // 监听文档关闭
        this.disposables.push(
            vscode.workspace.onDidCloseTextDocument(doc => {
                this.removeDocument(doc.uri.toString());
            })
        );

        // 监听选择变化
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                this.handleSelectionChange(e.textEditor.document, e.selections);
            })
        );

        // 同步已打开的文档
        for (const doc of vscode.workspace.textDocuments) {
            this.syncDocument(doc);
        }

        Logger.trace('[VSCodeWorkspaceAdapter] 初始化完成（文档变化已优化为防抖批处理）');
    }

    getWorkspace(): MutableObservableWorkspace {
        return this.workspace;
    }

    /**
     * 同步 VS Code 文档到 ObservableWorkspace
     */
    syncDocument(vscodeDoc: vscode.TextDocument): MutableObservableDocument {
        const uriStr = vscodeDoc.uri.toString();

        // 如果文档已存在，更新内容
        let doc = this.documentMap.get(uriStr);
        if (doc) {
            const newContent = vscodeDoc.getText();
            const currentValue = doc.value.get();
            if (currentValue.getValue() !== newContent) {
                doc.setValue(new StringText(newContent), undefined, vscodeDoc.version);
            }
            return doc;
        }

        // 创建新的 ObservableDocument
        const documentId = DocumentId.create(uriStr);
        const languageId = LanguageId.create(vscodeDoc.languageId);
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscodeDoc.uri);

        doc = this.workspace.addDocument({
            id: documentId,
            workspaceRoot: workspaceFolder ? URI.parse(workspaceFolder.uri.toString()) : undefined,
            initialValue: vscodeDoc.getText(),
            initialVersionId: vscodeDoc.version,
            languageId: languageId
        });

        this.documentMap.set(uriStr, doc);
        Logger.trace(`[VSCodeWorkspaceAdapter] 同步文档: ${vscodeDoc.fileName}`);

        return doc;
    }

    /**
     * 处理文档变化
     * //不需要实现
     */
    private handleDocumentChange(vscodeDoc: vscode.TextDocument): void {
        const doc = this.documentMap.get(vscodeDoc.uri.toString());
        if (doc) {
            doc.setValue(new StringText(vscodeDoc.getText()), undefined, vscodeDoc.version);
            // Logger.trace(`[VSCodeWorkspaceAdapter] 文档更新: ${vscodeDoc.fileName}, version=${vscodeDoc.version}`);
        } else {
            // 文档不存在，同步它
            this.syncDocument(vscodeDoc);
        }
    }

    /**
     * 处理选择变化
     */
    private handleSelectionChange(vscodeDoc: vscode.TextDocument, selections: readonly vscode.Selection[]): void {
        const doc = this.documentMap.get(vscodeDoc.uri.toString());
        if (doc) {
            const offsetRanges = selections.map(sel => {
                const startOffset = vscodeDoc.offsetAt(sel.start);
                const endOffset = vscodeDoc.offsetAt(sel.end);
                return new OffsetRange(startOffset, endOffset);
            });
            doc.setSelection(offsetRanges);
        }
    }

    /**
     * 移除文档
     */
    private removeDocument(uriStr: string): void {
        const doc = this.documentMap.get(uriStr);
        if (doc) {
            doc.dispose();
            this.documentMap.delete(uriStr);
            Logger.trace(`[VSCodeWorkspaceAdapter] 移除文档: ${uriStr}`);
        }
    }

    /**
     * 获取文档 ID
     */
    getDocumentId(uri: vscode.Uri): DocumentId {
        return DocumentId.create(uri.toString());
    }

    dispose(): void {
        // 清除防抖定时器
        if (this.documentChangeTimer) {
            clearTimeout(this.documentChangeTimer);
            this.documentChangeTimer = null;
        }
        this.pendingDocumentChanges.clear();

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.disposables.length = 0;

        for (const doc of this.documentMap.values()) {
            doc.dispose();
        }
        this.documentMap.clear();
        this.workspace.clear();
    }
}
