# VS Code 内置 Diff 功能详解

## 1. 核心 Diff API

### WorkspaceEdit - 批量编辑

```typescript
const edit = new vscode.WorkspaceEdit();

// 替换文本
edit.replace(document.uri, range, newText);

// 插入文本
edit.insert(document.uri, position, text);

// 删除文本
edit.delete(document.uri, range);

// 重命名文件
edit.renameFile(oldUri, newUri);

// 应用编辑
await vscode.workspace.applyEdit(edit);
```

### TextEditor.edit() - 原子性编辑

```typescript
await editor.edit(
    editBuilder => {
        editBuilder.replace(range, newText);
        editBuilder.insert(position, text);
        editBuilder.delete(range);
    },
    {
        undoStopBefore: true, // 在编辑前创建撤销点
        undoStopAfter: true // 在编辑后创建撤销点
    }
);
```

## 2. 内置 Diff 查看器

### 基本用法

```typescript
// 显示文件对比
await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri, // 原始文件 URI
    modifiedUri, // 修改后文件 URI
    'Diff Title' // 显示标题
);
```

### 高级选项

```typescript
// 使用临时文件对比
const originalUri = vscode.Uri.parse(`untitled:original.txt`);
const modifiedUri = vscode.Uri.parse(`untitled:modified.txt`);

// 显示内联差异
await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, 'My Diff', {
    preserveViewState: true,
    selection: new vscode.Range(10, 0, 15, 0)
});
```

## 3. 文本处理 API

### 范围计算

```typescript
// 计算行范围
const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    new vscode.Position(endLine, document.lineAt(endLine).text.length)
);

// 获取范围内的文本
const text = document.getText(range);
```

### 位置转换

```typescript
// 行号转换为位置
const position = new vscode.Position(lineNumber, columnNumber);

// 偏移量转换为位置
const positionFromOffset = document.positionAt(offset);

// 位置转换为偏移量
const offset = document.offsetAt(position);
```

## 4. 内置文件操作

### 文件系统 API

```typescript
// 读取文件
const content = await vscode.workspace.fs.readFile(uri);

// 写入文件
await vscode.workspace.fs.writeFile(uri, buffer);

// 文件状态
const stat = await vscode.workspace.fs.stat(uri);
```

### 文档管理

```typescript
// 打开文档
const document = await vscode.workspace.openTextDocument(uri);

// 保存文档
await document.save();

// 关闭文档
await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
```

## 5. 撤销/重做集成

### 编辑元数据

```typescript
const edit = new vscode.WorkspaceEdit();
edit.replace(uri, range, newText);

// 设置编辑标签（在撤销历史中显示）
edit.metadata = {
    label: 'Apply Diff',
    needsConfirmation: false
};

await vscode.workspace.applyEdit(edit);
```

### 编辑选项

```typescript
await editor.edit(
    editBuilder => {
        editBuilder.replace(range, newText);
    },
    {
        undoStopBefore: true, // 创建撤销分界点
        undoStopAfter: true // 创建撤销分界点
    }
);
```

## 6. 我们的实现优势

### ✅ 已经利用的功能：

- `TextEditor.edit()` 进行原子性编辑
- `WorkspaceEdit` 进行批量操作
- `vscode.diff` 显示预览
- 撤销/重做集成
- 编辑元数据追踪

### 🚀 可以改进的地方：

1. 使用 `vscode.workspace.fs` API 替代 Node.js fs
2. 利用 VS Code 的文本范围计算
3. 更好地集成到 Git 工作流
4. 使用内置的文本编码处理

## 总结

VS Code 确实内置了强大的 diff 应用功能，我们的实现已经很好地利用了这些功能：

- ✅ **原子性编辑** - 支持撤销/重做
- ✅ **批量操作** - WorkspaceEdit API
- ✅ **可视化预览** - 内置 diff 查看器
- ✅ **编辑追踪** - 元数据和变更历史
- ✅ **文档集成** - 与 VS Code 编辑器深度集成

我们的 applyDiff 工具在利用 VS Code 内置功能方面已经做得很好了！
