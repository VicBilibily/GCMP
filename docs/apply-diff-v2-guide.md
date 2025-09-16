# Apply Diff V2 工具使用指南

## 🚀 全新重构的 Apply Diff 工具

Apply Diff V2 是一个完全重新设计和实现的工具，充分利用了 VS Code 的内置功能并集成了聊天修改历史追踪。

## ✨ 主要特性

### 🔧 VS Code 原生集成

- **TextEditor.edit()** - 支持撤销/重做的原子性编辑
- **WorkspaceEdit** - 批量文件编辑操作
- **vscode.diff** - 内置差异查看器预览
- **ChatResponseTextEditPart** - 聊天响应中的编辑部分

### 📝 聊天修改历史

- **ChatUserActionEvent** - 监听用户操作事件
- **ChatRequest.editedFileEvents** - 跟踪文件编辑事件
- **编辑会话管理** - 跟踪多文件编辑会话
- **操作记录** - 详细的编辑操作日志

### 🧠 智能功能

- **智能内容匹配** - 模糊匹配和精确匹配
- **置信度评估** - 评估diff应用的可靠性
- **语言检测** - 自动识别编程语言
- **错误恢复** - 智能回滚和错误处理

### 🔍 预览和验证

- **实时预览** - 使用 VS Code 内置 diff 查看器
- **批量操作** - 支持多个diff块的批量应用
- **安全验证** - 应用前的完整性检查

## 📖 使用方法

### 1. 启用工具

在 VS Code 设置中启用：

```json
{
    "gcmp.applyDiff.v2Enabled": true
}
```

### 2. 基本 diff 格式

```diff
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
const version = '1.0.0';
=======
const version = '1.1.0';
>>>>>>> REPLACE
```

### 3. 插入操作

```diff
<<<<<<< SEARCH
:start_line:1
:end_line:0
=======
// 新增的代码
console.log('Hello World');
>>>>>>> REPLACE
```

### 4. 多块操作

```diff
<<<<<<< SEARCH
:start_line:1
:end_line:1
-------
const version = '1.0.0';
=======
const version = '2.0.0';
>>>>>>> REPLACE
<<<<<<< SEARCH
:start_line:10
:end_line:12
-------
function oldFunction() {
    return 'old';
}
=======
function newFunction() {
    return 'new and improved';
}
>>>>>>> REPLACE
```

## 🎯 工具调用

### 在聊天中使用

```
@gcmp_applyDiffV2 {
    "path": "src/example.js",
    "diff": "您的diff内容",
    "preview": false
}
```

### 预览模式

```
@gcmp_applyDiffV2 {
    "path": "src/example.js",
    "diff": "您的diff内容",
    "preview": true
}
```

## 🛠️ 演示命令

### 运行演示

使用命令面板执行：`GCMP: Apply Diff V2 演示`

### 创建测试 diff

1. 在编辑器中选择要修改的文本
2. 使用命令：`GCMP: 创建测试 Diff`
3. 系统将生成相应的 diff 模板

## 🔄 与 V1 版本的对比

| 特性         | V1 版本  | V2 版本          |
| ------------ | -------- | ---------------- |
| VS Code 集成 | 基础集成 | 深度原生集成     |
| 聊天历史     | 无       | 完整支持         |
| 预览功能     | 文本预览 | 内置 diff 查看器 |
| 错误处理     | 基础处理 | 智能恢复         |
| 内容匹配     | 严格匹配 | 智能匹配         |
| 批量操作     | 支持     | 增强支持         |
| 撤销/重做    | 支持     | 原生支持         |

## 💡 最佳实践

1. **使用预览模式** - 对重要修改先预览
2. **提供准确行号** - 提高匹配精度
3. **检查内容匹配** - 确保SEARCH内容与文件一致
4. **批量操作顺序** - 按文件逻辑顺序组织diff块
5. **保持简洁** - 单个diff块不要过大

## 🚨 注意事项

- V2 版本默认启用，V1 版本默认禁用
- 两个版本可以同时启用但建议只使用一个
- V2 版本需要 VS Code 1.104.0+ 版本
- 聊天集成功能需要相应的 proposed API 支持

## 🐛 故障排除

### 工具未显示

1. 检查 VS Code 版本 (≥1.104.0)
2. 确认配置已启用
3. 重新加载窗口

### diff 应用失败

1. 检查文件是否存在
2. 验证 SEARCH 内容是否匹配
3. 使用预览模式诊断问题

### 聊天集成不工作

1. 确认 VS Code 版本支持相关 API
2. 检查扩展日志输出
3. 某些 proposed API 可能不在所有环境中可用

## 📊 性能优化

- 使用 VS Code 原生 API 减少开销
- 智能匹配算法优化性能
- 批量操作减少多次文件操作
- 内存中预览避免临时文件
