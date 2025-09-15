# VS Code 变更跟踪集成文档

## 概述

本文档描述了GCMP扩展中`applyDiff`工具与VS Code变更跟踪系统的集成改进。

## 集成功能

### 1. 文档变更跟踪

#### 实现的功能：
- **变更事件监听**: 使用`vscode.workspace.onDidChangeTextDocument`监听diff应用引起的文档变更
- **变更详情记录**: 记录变更的文件、版本、行数等详细信息
- **变更来源识别**: 通过`TextDocumentDetailedChangeReason` API标记变更来源为`gcmp-apply-diff`

#### 代码示例：
```typescript
// 监听文档变更事件
const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (this.isApplyingDiff) {
        this.handleDiffDocumentChange(event);
    }
});
```

### 2. 文档版本检查

#### 实现的功能：
- **SHA1哈希验证**: 使用crypto模块计算文档内容的SHA1哈希值
- **版本冲突检测**: 在应用diff前检查文件是否已被修改
- **用户确认机制**: 版本不匹配时询问用户是否继续

#### 代码示例：
```typescript
private computeDocumentSHA1(content: string): string {
    return crypto.createHash('sha1').update(content, 'utf8').digest('hex');
}

private async checkDocumentVersion(filePath: string, expectedContent?: string): Promise<boolean> {
    // 检查文档版本并处理冲突
}
```

### 3. 撤销/重做集成

#### 实现的功能：
- **编辑器API优先**: 优先使用`TextEditor.edit()`方法，自动集成到撤销栈
- **撤销点管理**: 设置`undoStopBefore`和`undoStopAfter`选项
- **WorkspaceEdit回退**: 当没有活动编辑器时回退到`WorkspaceEdit` API

#### 代码示例：
```typescript
const success = await activeEditor.edit((editBuilder) => {
    edits.forEach(edit => {
        editBuilder.replace(edit.range, edit.newText);
    });
}, {
    undoStopBefore: true,  // 在编辑前创建撤销点
    undoStopAfter: true    // 在编辑后创建撤销点
});
```

### 4. 变更元数据标记

#### 实现的功能：
- **变更源标识**: 为所有diff操作添加`source: 'gcmp-apply-diff'`标记
- **元数据丰富**: 包含工具信息、时间戳、操作块数等详细信息
- **WorkspaceEdit标签**: 为工作区编辑添加"GCMP Apply Diff"标签

#### 代码示例：
```typescript
const changeReason = {
    source: 'gcmp-apply-diff',
    metadata: {
        tool: 'applyDiff',
        extension: 'gcmp',
        timestamp: new Date().toISOString(),
        blocksCount: edits.length
    }
};
```

## API配置

### Proposed APIs

在`package.json`中启用了以下proposed APIs：

```json
"enabledApiProposals": [
    "chatProvider",
    "textDocumentChangeReason"
]
```

- `textDocumentChangeReason`: 允许为文档变更提供详细的原因信息

## 测试套件

### VS Code集成测试

创建了专门的集成测试套件 `ApplyDiffVSCodeIntegrationTests`，包含以下测试：

1. **基本diff应用功能测试**
2. **文档变更跟踪测试**
3. **版本冲突检测测试**
4. **撤销/重做集成测试**
5. **工作区编辑元数据测试**

### 运行测试

在开发模式下可以通过命令面板运行：
```
GCMP: 运行 VS Code 集成测试
```

## 优势与改进

### 相比之前的文件系统方法：

1. **更好的VS Code集成**: 
   - diff操作正确显示在VS Code的变更跟踪中
   - 支持标准的撤销/重做操作
   - 变更被正确标记和识别

2. **更强的安全性**:
   - 版本冲突检测防止意外覆盖
   - 文档完整性验证
   - 用户确认机制

3. **更好的用户体验**:
   - 变更操作集成到编辑器历史
   - 支持VS Code的原生撤销/重做
   - 清晰的变更来源标识

4. **更强的鲁棒性**:
   - 多种API的回退机制
   - 详细的错误处理和日志
   - 全面的测试覆盖

## 实现要点

### 资源管理

```typescript
class ApplyDiffTool {
    constructor() {
        this.setupChangeTracking();
    }

    dispose(): void {
        // 清理所有监听器
        for (const [path, disposable] of this.documentChangeDisposables) {
            disposable.dispose();
        }
        this.documentChangeDisposables.clear();
    }
}
```

### 错误处理

所有VS Code API调用都包含适当的错误处理，在API失败时回退到文件系统方法：

```typescript
if (useVSCodeAPI) {
    const success = await this.applyChangesWithVSCodeAPI(request.path, textEdits);
    if (!success) {
        // 回退到文件系统方法
        Logger.warn('⚠️ [Apply Diff] VS Code API失败，回退到文件系统方法');
    }
}
```

## 未来改进

1. **更多proposed APIs**: 当更多VS Code proposed APIs稳定化时，可以利用更多功能
2. **增强的冲突解决**: 提供更智能的冲突解决策略
3. **批量操作优化**: 对多文件diff操作的进一步优化
4. **实时预览**: 在应用前提供实时的diff预览

## 总结

通过集成VS Code的变更跟踪系统，`applyDiff`工具现在提供了更加原生和无缝的编辑体验，同时保持了原有的强大功能和安全性。这些改进使得AI辅助的代码编辑更好地融入了VS Code的工作流程。