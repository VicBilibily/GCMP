import * as vscode from 'vscode';
import { OffsetRange } from '@vscode/chat-lib/dist/src/_internal/util/vs/editor/common/core/ranges/offsetRange';
import {
    MutableObservableDocument,
    MutableObservableWorkspace
} from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/observableWorkspace';
import { StringText } from '@vscode/chat-lib/dist/src/_internal/util/vs/editor/common/core/text/abstractText';
import { DocumentId } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/dataTypes/documentId';
import { LanguageId } from '@vscode/chat-lib/dist/src/_internal/platform/inlineEdits/common/dataTypes/languageId';
import { URI } from '@vscode/chat-lib/dist/src/_internal/util/vs/base/common/uri';
import { getCompletionLogger } from './singletons';

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
        //         // 不在此处处理文档变化，触发提示前再进行同步
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
                const CompletionLogger = getCompletionLogger();
                const uriStr = doc.uri.toString();
                const docToRemove = this.documentMap.get(uriStr);
                if (docToRemove) {
                    docToRemove.dispose();
                    this.documentMap.delete(uriStr);
                    CompletionLogger.trace(`[VSCodeWorkspaceAdapter] Removed document: ${uriStr}`);
                }
            })
        );

        // 监听选择变化
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => {
                const doc = this.documentMap.get(e.textEditor.document.uri.toString());
                if (doc) {
                    this._applyEditorSelectionToDoc(e.textEditor, doc);
                }
            })
        );

        // 监听活动编辑器变化，为新激活的文档同步当前选择
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(e => {
                if (!e) {
                    return;
                }
                const doc = this.documentMap.get(e.document.uri.toString());
                if (doc) {
                    this._applyEditorSelectionToDoc(e, doc);
                }
            })
        );

        // 同步已打开的文档
        for (const doc of vscode.workspace.textDocuments) {
            this.syncDocument(doc);
        }
    }

    getWorkspace(): MutableObservableWorkspace {
        return this.workspace;
    }

    /**
     * 同步 VS Code 文档到 ObservableWorkspace
     */
    syncDocument(vscodeDoc: vscode.TextDocument): MutableObservableDocument {
        const CompletionLogger = getCompletionLogger();
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

        // 初始选择为空会导致 NES 的 HistoryContextProvider 把该文档视为非用户文档，
        // 从而在首次触发 NES 时抛出 DocumentMissingInHistoryContext。
        // 因此这里根据当前可见编辑器的选择进行初始化。
        const visibleEditor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uriStr);
        if (visibleEditor) {
            this._applyEditorSelectionToDoc(visibleEditor, doc);
        }

        this.documentMap.set(uriStr, doc);
        CompletionLogger.trace(`[VSCodeWorkspaceAdapter] Synced document: ${vscodeDoc.fileName}`);

        return doc;
    }

    /**
     * 将 VS Code 编辑器的选择同步到 ObservableDocument
     */
    private _applyEditorSelectionToDoc(editor: vscode.TextEditor, doc: MutableObservableDocument): void {
        const offsetRanges = editor.selections.map(sel => {
            const startOffset = editor.document.offsetAt(sel.start);
            const endOffset = editor.document.offsetAt(sel.end);
            return new OffsetRange(startOffset, endOffset);
        });
        doc.setSelection(offsetRanges);
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
