# CI/CD 配置说明

本项目已配置 GitHub Actions 自动化工作流，用于代码检查和发布管理。

## 🔧 工作流说明

### 1. CI 工作流 (`ci.yml`)
**触发条件**：
- 推送到 `main` 分支
- 创建 Pull Request 到 `main` 分支

**执行步骤**：
- 在 Node.js 20.x 环境下测试
- 安装依赖
- 运行 ESLint 代码检查
- 编译 TypeScript
- 打包扩展
- 上传构建产物

### 2. Release 工作流 (`release.yml`)
**触发条件**：
- 发布新的 GitHub Release

**执行步骤**：
- 代码检查和编译
- 打包扩展
- 获取包信息（名称和版本）
- 自动发布到 VS Code 扩展商店
- 将 VSIX 文件作为 Release 资产上传（使用现代化的 action）

## 🔑 必需的 Secrets 配置

在 GitHub 仓库中需要配置以下 Secrets：

### 1. VSCE_PAT (VS Code 扩展商店发布令牌)

1. 访问 [Azure DevOps](https://dev.azure.com/)
2. 创建个人访问令牌 (Personal Access Token)
3. 权限设置：
   - **Organization**: All accessible organizations
   - **Scopes**: Marketplace > Manage
4. 复制生成的令牌
5. 在 GitHub 仓库设置中添加 Secret:
   - Name: `VSCE_PAT`
   - Value: 你的 Azure DevOps PAT

### 2. GITHUB_TOKEN (自动提供)
GitHub Actions 会自动提供 `GITHUB_TOKEN`，用于上传 Release 资产。

## 📦 发布流程

### 自动发布（推荐）
1. 在本地更新版本号：
   ```bash
   npm version patch  # 或 minor/major
   ```

2. 推送标签到 GitHub：
   ```bash
   git push origin main --tags
   ```

3. 在 GitHub 创建 Release：
   - 选择对应的标签
   - 填写 Release 说明
   - 点击 "Publish release"

4. GitHub Actions 将自动：
   - 运行测试和检查
   - 构建扩展
   - 发布到 VS Code 扩展商店
   - 上传 VSIX 文件到 Release

### 手动发布
如果需要手动发布：
```bash
# 安装依赖
npm ci

# 编译
npm run compile

# 打包
npm run package

# 发布
npm run publish
```

## 🔍 版本管理

建议遵循 [语义化版本](https://semver.org/) 规范：
- `patch` (1.0.0 → 1.0.1): 错误修复
- `minor` (1.0.0 → 1.1.0): 新功能，向后兼容
- `major` (1.0.0 → 2.0.0): 破坏性变更

## 📝 Release Notes

创建 Release 时，建议包含：
- 新功能说明
- 修复的问题
- 破坏性变更（如有）
- 升级说明（如有）

## 🚨 注意事项

1. **版本号同步**：确保 `package.json` 中的版本号与 Git 标签一致
2. **扩展 ID**：发布后扩展 ID 为 `vicanent.gcmp`
3. **审核时间**：VS Code 扩展商店审核通常需要几分钟到几小时
4. **回滚**：如需撤回版本，需要手动在扩展商店中操作
5. **Proposed API**：本扩展使用了 `chatProvider` proposed API，因此在打包和发布时会自动添加 `--allow-proposed-apis chatProvider` 参数

## 🔧 Proposed API 说明

VS Code 扩展使用了 proposed API (`chatProvider`)，这是 VS Code 团队正在开发的实验性 API。为了发布到扩展商店，需要：

- 打包时：`vsce package`（正常打包，不需要特殊参数）
- 发布时：`vsce publish --allow-proposed-apis chatProvider`

这些参数已经在 `package.json` 脚本和 GitHub Actions 中配置好了。