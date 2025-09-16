## applyDiff 卡住问题修复报告

### 问题分析

用户反馈 diff 工具在第一个操作就卡住了。经过分析发现问题根源是：

1. **用户确认机制阻塞**：工具在 `requireConfirmation: true` 时会弹出用户确认对话框
2. **Promise.race 超时处理**：虽然设置了15秒超时，但在某些情况下仍可能导致工具卡住
3. **不必要的用户交互**：由于工具已接入 VS Code 历史修改机制，支持撤销/重做，不需要额外的用户确认

### 修复方案

完全移除用户确认机制，让工具直接执行：

#### 1. 移除用户确认逻辑 ✅

- 删除了 `applyDiff` 方法中的用户确认对话框
- 移除了 `Promise.race` 超时处理
- 简化了执行流程

#### 2. 更新接口定义 ✅

- 从 `ApplyDiffRequest` 接口中移除 `requireConfirmation?` 参数
- 更新所有调用代码，移除 `requireConfirmation: true` 设置

#### 3. 更新命令集成 ✅

- 修改 `apply-diff-commands.ts` 中的两个命令
- 将 `requireConfirmation: true` 改为 `preview: false`

#### 4. 更新文档和示例 ✅

- 修复示例代码中的过时参数引用
- 更新使用指南，强调支持撤销/重做机制

### 技术细节

```typescript
// 修复前（会卡住）
if (request.requireConfirmation) {
    const userChoice = await Promise.race([
        vscode.window.showInformationMessage(...),
        new Promise<undefined>((_, reject) =>
            setTimeout(() => reject(new Error('用户确认超时')), 15000)
        )
    ]);
    // 处理用户选择...
}

// 修复后（直接执行）
// 工具直接执行，无需用户确认（因为已接入VS Code历史修改机制）
Logger.debug('🔧 [Apply Diff] 直接执行diff应用（支持撤销/重做）');
```

### 优势

1. **性能提升**：消除了用户交互延迟
2. **用户体验**：工具响应更快，无需等待确认
3. **安全保障**：依然安全，因为VS Code提供了完整的撤销/重做机制
4. **一致性**：与其他VS Code工具的行为保持一致

### 测试方法

要测试修复后的功能：

1. **启用applyDiff工具**
    - 打开VS Code设置
    - 搜索 "gcmp.applyDiff.enabled"
    - 将其设置为 `true`

2. **使用正确的diff格式**

    ```
    <<<<<<< SEARCH
    :start_line:行号
    :end_line:行号
    原始内容
    =======
    新内容
    >>>>>>> REPLACE
    ```

3. **测试用例**
    - 创建测试文件
    - 使用applyDiff工具进行修改
    - 检查结果

### 注意事项

- 确保行号从1开始计数
- 搜索内容必须与文件内容精确匹配（支持空白字符的宽松匹配）
- 建议先使用preview模式测试
