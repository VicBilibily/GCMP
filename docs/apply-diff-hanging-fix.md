# Apply Diff 工具第二次调用卡住问题修复

## 问题描述

用户报告 `applyDiff` 工具在第二次调用时会卡住，无法正常响应。

## 问题分析

通过代码审查发现了以下几个可能导致第二次调用卡住的问题：

### 1. 工具实例生命周期管理问题
- **问题**: 在 `registry.ts` 中，每次启用工具时都创建新的 `ApplyDiffTool` 实例，但在注销时没有正确清理之前实例的资源
- **影响**: 导致监听器累积，可能引发内存泄漏和性能问题

### 2. 模态对话框阻塞问题
- **问题**: 使用 `{ modal: true }` 的对话框在某些情况下可能不会正确显示或响应
- **影响**: Promise 永远不会 resolve，导致整个工具调用卡住

### 3. 缺乏竞态条件保护
- **问题**: 没有检查是否有其他 diff 操作正在进行
- **影响**: 多个并发调用可能导致状态混乱

### 4. 资源释放检查缺失
- **问题**: 没有检查工具实例是否已被释放
- **影响**: 在已释放的实例上调用方法可能导致未定义行为

## 修复方案

### 1. 改进工具实例生命周期管理

**修改文件**: `src/tools/registry.ts`

```typescript
// 保存工具实例引用
let applyDiffToolInstance: ApplyDiffTool | undefined;

function toggleApplyDiffTool(context: vscode.ExtensionContext, enabled: boolean): void {
    if (enabled && !applyDiffDisposable) {
        applyDiffToolInstance = new ApplyDiffTool();
        // ...注册逻辑
    } else if (!enabled && applyDiffDisposable) {
        // 注销工具
        applyDiffDisposable.dispose();
        applyDiffDisposable = undefined;
        
        // 清理工具实例资源
        if (applyDiffToolInstance) {
            applyDiffToolInstance.dispose();
            applyDiffToolInstance = undefined;
        }
    }
}
```

### 2. 添加对话框超时处理

**修改文件**: `src/tools/apply-diff.ts`

```typescript
// 版本检查对话框
const result = await Promise.race([
    vscode.window.showWarningMessage(
        `文件已被修改，是否仍要应用diff？`,
        { modal: false }, // 改为非模态
        '继续应用',
        '取消'
    ),
    new Promise<undefined>((_, reject) => 
        setTimeout(() => reject(new Error('用户确认超时')), 10000)
    )
]);

// 用户确认对话框
const userChoice = await Promise.race([
    vscode.window.showInformationMessage(
        `即将应用 ${diffBlocks.length} 个diff块`,
        { modal: false }, // 改为非模态
        '应用修改',
        '查看预览'
    ),
    new Promise<undefined>((_, reject) => 
        setTimeout(() => reject(new Error('用户确认超时')), 15000)
    )
]);
```

### 3. 添加竞态条件保护

```typescript
async applyDiff(request: ApplyDiffRequest): Promise<ApplyDiffResponse> {
    // 检查工具是否已被释放
    if (this.isDisposed) {
        return {
            success: false,
            message: '工具已被释放，无法执行操作',
            blocksApplied: 0
        };
    }

    // 检查是否有其他diff操作正在进行
    if (this.isApplyingDiff) {
        return {
            success: false,
            message: '已有diff操作正在进行中，请稍后重试',
            blocksApplied: 0
        };
    }

    // ...执行diff应用逻辑
}
```

### 4. 增强资源管理

```typescript
export class ApplyDiffTool {
    private isDisposed = false;

    dispose(): void {
        if (this.isDisposed) {
            return;
        }

        this.isDisposed = true;

        // 清理所有监听器
        for (const [path, disposable] of this.documentChangeDisposables) {
            disposable.dispose();
        }
        this.documentChangeDisposables.clear();

        // 清理备份
        this.backupMap.clear();
    }
}
```

### 5. 添加详细的调试日志

```typescript
async invoke(request: vscode.LanguageModelToolInvocationOptions<ApplyDiffRequest>): Promise<vscode.LanguageModelToolResult> {
    const invocationId = Math.random().toString(36).substr(2, 9);
    Logger.info(`🚀 [工具调用 ${invocationId}] Apply Diff工具被调用`);
    
    try {
        // ...执行逻辑
        Logger.info(`✅ [工具调用 ${invocationId}] Apply Diff工具调用成功`);
    } catch (error) {
        Logger.error(`❌ [工具调用 ${invocationId}] Apply Diff工具调用失败: ${error.message}`);
        // ...错误处理
    }
}
```

## 修复效果

1. **防止资源泄漏**: 确保每次工具重新注册时正确清理之前的资源
2. **避免对话框阻塞**: 使用超时机制和非模态对话框避免永久阻塞
3. **防止并发冲突**: 添加状态检查避免多个操作同时进行
4. **提高调试能力**: 详细的日志帮助快速定位问题
5. **增强错误处理**: 为各种错误情况提供明确的处理和用户反馈

## 测试建议

1. **连续调用测试**: 多次连续调用工具验证不会卡住
2. **并发调用测试**: 同时发起多个调用验证互斥机制
3. **超时测试**: 在对话框不响应的情况下验证超时机制
4. **资源清理测试**: 验证工具注销后资源正确释放

## 预防措施

1. **定期代码审查**: 关注异步操作和资源管理
2. **完善测试覆盖**: 包含边界情况和异常场景
3. **监控工具状态**: 在生产环境中监控工具的调用状态和性能
4. **用户反馈机制**: 提供清晰的错误信息和操作指导

通过这些修复，`applyDiff` 工具现在应该能够稳定地处理多次调用，不会出现第二次调用卡住的问题。