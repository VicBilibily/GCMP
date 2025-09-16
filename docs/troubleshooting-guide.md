# Apply Diff V2 工具故障排除指南

## 🔍 诊断步骤

### 1. 检查扩展状态

运行诊断命令：

- 打开命令面板 (`Ctrl+Shift+P`)
- 执行：`GCMP: 工具诊断`
- 查看输出窗口中的诊断结果

### 2. 检查 VS Code 版本

确保您使用的是 VS Code 1.104.0 或更高版本：

```bash
code --version
```

### 3. 检查扩展配置

在 VS Code 设置中确认：

```json
{
    "gcmp.applyDiff.v2Enabled": true
}
```

### 4. 检查工具注册状态

在输出窗口（选择 "GCMP"）中查找以下消息：

- `✅ [工具注册] Apply Diff V2 工具已注册: gcmp_applyDiffV2`

## 🚨 常见问题

### 问题 1: 工具未显示在 Copilot 中

**可能原因：**

- 工具未正确注册
- 配置被禁用
- VS Code 版本过低

**解决方案：**

1. 运行 `GCMP: 工具诊断` 命令
2. 检查设置中的 `gcmp.applyDiff.v2Enabled`
3. 重新加载 VS Code 窗口 (`Ctrl+Shift+P` → "Developer: Reload Window")

### 问题 2: 工具调用失败

**可能原因：**

- 参数格式不正确
- 文件路径错误
- 权限问题

**解决方案：**

1. 检查 diff 格式是否正确
2. 确保文件路径存在
3. 使用预览模式测试：`"preview": true`

### 问题 3: VS Code API 不可用

**错误信息：** `vscode.lm.registerTool API 不可用`

**解决方案：**

1. 确认 VS Code 版本 ≥ 1.104.0
2. 检查 `enabledApiProposals` 配置
3. 重新安装扩展

## 🔧 手动测试工具

### 测试命令

1. `GCMP: Apply Diff V2 演示` - 运行内置演示
2. `GCMP: 创建测试 Diff` - 从选中文本创建 diff 模板
3. `GCMP: 工具诊断` - 完整诊断报告

### 直接在聊天中测试

```
请使用 @gcmp_applyDiffV2 工具来预览以下更改：

{
    "path": "test.txt",
    "diff": "<<<<<<< SEARCH\n:start_line:1\n:end_line:1\n-------\nHello World\n=======\nHello VS Code\n>>>>>>> REPLACE",
    "preview": true
}
```

## 📋 诊断信息收集

如果问题仍然存在，请收集以下信息：

1. **VS Code 版本**
2. **扩展版本**
3. **诊断命令输出**
4. **具体错误信息**
5. **操作系统信息**

### 获取详细日志

1. 打开输出窗口
2. 选择 "GCMP" 频道
3. 复制相关日志信息

## 🛠️ 高级故障排除

### 检查 Language Model API

在 VS Code 开发者控制台中运行：

```javascript
// 检查 API 可用性
console.log('vscode.lm:', !!vscode.lm);
console.log('registerTool:', !!vscode.lm?.registerTool);
console.log('tools:', vscode.lm?.tools?.length);

// 查看所有工具
vscode.lm?.tools?.forEach(tool => {
    console.log(`Tool: ${tool.name} - ${tool.description}`);
});
```

### 重新注册工具

1. 禁用扩展
2. 重新启用扩展
3. 重新加载窗口
4. 检查工具注册状态

## 🆘 获取支持

如果以上步骤都无法解决问题，请：

1. 运行完整诊断并保存结果
2. 在 GitHub 仓库提交 Issue
3. 包含诊断信息和错误日志
4. 描述具体的复现步骤

---

**注意：** 某些功能可能需要 VS Code Insiders 版本或特定的 API 提案支持。
