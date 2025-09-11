<!-- 
为 GitHub Copilot 提供工作空间特定的自定义指令
详细信息请访问：https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file
-->

# GCMP - GitHub Copilot 多模型供应商扩展

## 🎯 项目概述

GCMP (GitHub Copilot Multi-Provider) 是一个专业的 VS Code 扩展，为 GitHub Copilot Chat 提供多个主流 AI 供应商的模型支持。通过实现双 SDK 架构设计，智能路由不同的 AI 模型请求，为开发者提供更丰富、更适合的 AI 编程助手选择。

**扩展标识符**: `vicanent.gcmp`  
**项目仓库**: https://github.com/VicBilibily/GCMP.git

## 🛠️ 技术栈

### 核心技术
- **开发语言**: TypeScript 
- **扩展框架**: VS Code Extension API
- **构建工具**: ESBuild (快速打包)
- **类型定义**: 完整的 TypeScript 类型支持

### 外部依赖
- **AI SDK**: 
  - `@anthropic-ai/sdk` - Anthropic 模型支持
  - `openai` - OpenAI 兼容模型支持
- **核心 API**: VS Code ChatProvider (proposed API)

### 开发工具
- **代码质量**: ESLint 配置
- **调试支持**: VS Code 调试配置
- **任务管理**: VS Code Tasks 集成

## 📁 项目架构

### 目录结构
```
GCMP/
├── 📁 src/                        # 源代码目录
│   ├── 📄 extension.ts            # 扩展主入口，激活和注册逻辑
│   ├── 📁 providers/              # AI 供应商实现层
│   │   ├── 📄 baseProvider.ts     # 抽象基类，定义通用接口
│   │   ├── 📄 zhipuProvider.ts    # 智谱AI GLM系列模型
│   │   ├── 📄 modelscopeProvider.ts # 魔搭社区通义千问系列
│   │   ├── 📄 deepseekProvider.ts  # DeepSeek 推理模型
│   │   ├── 📄 iflowProvider.ts     # iFlow心流多模型聚合
│   │   └── 📄 moonshotProvider.ts  # 月之暗面Kimi系列
│   ├── 📁 handlers/               # SDK 处理器层
│   │   ├── 📄 anthropicHandler.ts # Anthropic SDK 请求处理
│   │   ├── 📄 openaiHandler.ts    # OpenAI SDK 请求处理
│   │   └── 📄 index.ts            # 处理器导出
│   ├── 📁 converters/             # 数据转换层
│   │   └── 📄 anthropicConverter.ts # Anthropic 格式转换器
│   ├── 📁 types/                  # 类型定义
│   │   ├── 📄 sharedTypes.ts      # 共享数据类型
│   │   └── 📄 vscodeTypes.ts      # VS Code 特定类型
│   ├── 📁 utils/                  # 工具函数
│   │   ├── 📄 apiKeyManager.ts    # API 密钥安全管理
│   │   ├── 📄 logger.ts           # 日志记录工具
│   │   └── 📄 index.ts            # 工具导出
│   └── 📁 vscode.d.ts/            # VS Code API 类型定义
├── 📁 .vscode/                    # VS Code 配置
│   ├── 📄 launch.json             # 调试启动配置
│   └── 📄 tasks.json              # 构建任务配置
├── 📄 package.json                # 扩展清单和依赖管理
├── 📄 tsconfig.json               # TypeScript 编译配置
├── 📄 esbuild.js                  # 构建脚本
└── 📄 eslint.config.mjs           # 代码质量配置
```

### 架构设计原则
- **🧩 模块化**: 每个供应商独立实现，职责清晰
- **🔌 可扩展**: 统一接口设计，轻松添加新供应商
- **🛡️ 安全性**: API 密钥安全存储和管理
- **⚡ 高性能**: 异步处理和流式响应支持

## ⚙️ 核心功能

### 🔄 双 SDK 支持
- **Anthropic SDK 路由**: 处理 Anthropic 格式的模型请求
- **OpenAI SDK 路由**: 处理 OpenAI 兼容格式的模型请求
- **智能选择**: 根据模型类型自动选择合适的 SDK

### 🤖 模型供应商管理
- **统一接口**: 实现 `LanguageModelChatProvider` 标准接口
- **多供应商支持**: 支持智谱AI、月之暗面、DeepSeek、魔搭社区、iFlow心流
- **动态注册**: 运行时动态注册和管理模型提供者

### 🔐 安全特性
- **API 密钥管理**: 使用 VS Code SecretStorage 安全存储
- **独立配置**: 每个供应商独立的密钥管理
- **命令工厂**: 标准化的密钥设置命令生成

### 🌊 流式响应
- **实时交互**: 支持流式对话响应
- **异步处理**: 高效的异步请求处理
- **错误恢复**: 完善的错误处理和重试机制

## 🚀 开发工作流

### 常用命令
| 命令 | 功能 | 描述 |
|------|------|------|
| `npm run watch` | 🔄 监听开发 | 自动编译和热重载 |
| `npm run compile` | 🔨 编译项目 | 一次性编译所有代码 |
| `npm run package` | 📦 打包发布 | 生成 VSIX 扩展包 |
| `npm run lint` | 🔍 代码检查 | ESLint 代码质量检查 |

### 调试配置
- **F5 启动**: 在扩展开发主机中启动调试
- **断点调试**: 支持完整的 TypeScript 断点调试
- **日志输出**: 集成的日志系统用于问题排查

## 🤖 AI 助手指令

当你在这个项目中工作时，请遵循以下指导原则：

### 代码风格
- 使用 TypeScript 严格模式，确保类型安全
- 遵循 ESLint 配置的代码规范
- 优先使用 async/await 而非 Promise.then
- 使用描述性的变量和函数命名

### 架构原则
- 新增供应商时，继承 `BaseProvider` 抽象类
- SDK 路由逻辑应集中在 handlers 目录中
- 类型定义应放在 types 目录，避免重复定义
- 工具函数应放在 utils 目录，保持功能单一

### 安全考虑
- API 密钥必须使用 VS Code SecretStorage 存储
- 敏感信息不得出现在日志中
- 网络请求应包含适当的错误处理和超时设置

### 扩展开发
- 新功能应考虑向后兼容性
- 扩展激活应尽可能快速，避免阻塞用户
- 命令注册使用统一的命名规范：`gcmp.{provider}.{action}`

### 测试和调试
- 重要功能应包含错误处理和日志记录
- 使用 logger 工具记录关键操作和错误信息
- 调试时优先使用 VS Code 调试器而非 console.log

## 支持的模型

### 模型供应商
- **智谱AI**: GLM系列模型，支持Anthropic SDK和OpenAI SDK
- **魔搭社区**: 通义千问系列，专业代码生成能力
- **DeepSeek**: 深度推理模型，思维链能力
- **iFlow心流**: 多模型聚合平台
- **月之暗面**: Kimi系列，长上下文理解

### 配置
使用VS Code命令配置各供应商的API密钥：
- 智谱AI：`gcmp.zhipu.setApiKey`
- 魔搭社区：`gcmp.modelscope.setApiKey`
- DeepSeek：`gcmp.deepseek.setApiKey`
- iFlow心流：`gcmp.iflow.setApiKey`
- 月之暗面：`gcmp.moonshot.setApiKey`