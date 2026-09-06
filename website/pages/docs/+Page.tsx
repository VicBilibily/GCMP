import './docs.css';
import { useT } from '../../src/i18n';

export default function Page() {
    const t = useT();
    return (
        <>
            <h1>{t('Documentation', '文档')}</h1>

            <section className="card">
                <h2>{t('Introduction', '简介')}</h2>
                <p>
                    {t(
                        'GCMP (AI Chat Models) is a VS Code extension that provides richer, locale-optimized model choices for GitHub Copilot Chat by integrating mainstream Chinese native LLM providers. It currently includes built-in support for ZhipuAI, MiniMax, MoonshotAI, DeepSeek, Alibaba Cloud, Kuaishou, Volcengine, Tencent Cloud, Xiaomi MiMo, Baidu, StepFun, Ant Group, iFlytek, LongCat and other',
                        'GCMP（AI Chat Models）是一个 VS Code 扩展，通过集成国内主流原生大模型提供商，为 GitHub Copilot Chat 提供更丰富、更适合本土需求的模型选择。目前已内置支持 智谱AI、MiniMax、MoonshotAI、DeepSeek、阿里云百炼、快手万擎、火山方舟、腾讯云、Xiaomi MiMo、百度千帆、阶跃星辰、蚂蚁百灵、讯飞星辰、LongCat 等'
                    )}
                    <strong>{t('native LLM', '原生大模型')}</strong>
                    {t(
                        ' providers; it also supports OpenAI and Anthropic API-compatible interfaces, allowing custom integration of any third-party',
                        '提供商；同时适配 OpenAI 与 Anthropic 的 API 兼容接口，可自定义接入任何提供兼容接口的第三方'
                    )}
                    <strong>{t('cloud service models', '云服务模型')}</strong>。
                </p>
            </section>

            <section className="card">
                <h2>{t('Installation', '安装')}</h2>
                <ul>
                    <li>
                        {t('Search for ', '在 VS Code 扩展市场搜索 ')}
                        <code>GCMP</code>
                        {t(' in the VS Code Marketplace and install, or visit the', ' 并安装，或直接访问')}
                        <a
                            href="https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp"
                            target="_blank"
                            rel="noreferrer"
                        >
                            {t(' Marketplace page', '扩展市场页面')}
                        </a>
                        {t(' (extension ID: ', '（扩展标识 ')}
                        <code>vicanent.gcmp</code>)。
                    </li>
                    <li>
                        {t(
                            'Prerequisites: VS Code >= 1.125.0, with the GitHub Copilot Chat extension installed.',
                            '前置要求：VS Code >= 1.125.0，并已安装 GitHub Copilot Chat 扩展。'
                        )}
                    </li>
                </ul>
            </section>

            <section className="card">
                <h2>{t('Quick Start', '快速开始')}</h2>
                <ol>
                    <li>
                        {t(
                            'Open the GitHub Copilot Chat panel in VS Code.',
                            '打开 VS Code 的 GitHub Copilot Chat 面板。'
                        )}
                    </li>
                    <li>
                        {t(
                            'Select "Manage Models" at the bottom of the model picker, then choose a provider from the list.',
                            '在模型选择器底部选择「管理模型」，从弹出的提供商列表中选择所需提供商。'
                        )}
                    </li>
                    <li>
                        {t(
                            'On first use, follow the prompts to set up your API Key.',
                            '首次使用会要求设置 API Key，按提示完成密钥配置。'
                        )}
                    </li>
                    <li>
                        {t(
                            'Return to the model picker, add and enable the target model, then start chatting.',
                            '返回模型选择器添加并启用目标模型，选中即可开始对话。'
                        )}
                    </li>
                </ol>
            </section>

            <section className="card">
                <h2>{t('Auxiliary Model Configuration (Recommended)', '辅助模型配置（推荐）')}</h2>
                <p>
                    {t(
                        'VS Code uses lightweight models in the background for tasks like title generation, commit message creation, and search. Without configuration, it falls back to the built-in Copilot model and consumes your monthly quota. Point these tasks to GCMP models to save quota:',
                        'VS Code 在后台使用轻量模型执行标题生成、提交信息创建、搜索等实用任务。未配置时会回退到 Copilot 内置模型并消耗月度额度。将这些任务指向 GCMP 模型可节省额度：'
                    )}
                </p>
                <pre>
                    <code>{`{
  // ${t('General utility tasks: title generation, summaries, intent classification, etc.', '通用实用任务：标题生成、摘要、意图分类等')}
  "chat.utilityModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-pro",
  // ${t('Lightweight utility tasks: commit messages, branch names, etc. (fast & low-cost model recommended)', '轻量实用任务：提交信息、分支名等（建议快速低成本模型）')}
  "chat.utilitySmallModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-flash",
  // ${t('GCMP built-in Commit message generation model', 'GCMP 内置 Commit 消息生成模型')}
  "gcmp.commit.model": { "provider": "zhipu", "model": "glm-4.7" },
  // ${t('GCMP built-in Vision analysis model (must support image input)', 'GCMP 内置视觉分析模型（必须支持图像输入）')}
  "gcmp.vision.model": { "provider": "zhipu", "model": "glm-4.6v" }
}`}</code>
                </pre>
                <p>
                    {t('You can also run ', '也可通过命令面板执行 ')}
                    <code>{t('GCMP: Set Utility Model', 'GCMP: 设置辅助工具模型')}</code>
                    {t(
                        ' from the command palette, or click "Set Utility Model" in the daily stats menu of the status bar Token icon to configure in the visual panel.',
                        '，或在状态栏 Token 消耗图标的每日统计菜单中点击「设置辅助工具模型」，在可视化面板统一配置。'
                    )}
                </p>
            </section>

            <section className="card">
                <h2>{t('Model Config Distribution', '模型配置分发')}</h2>
                <p>
                    {t(
                        'This site publishes the provider model configs from the same source as the extension (src/providers/config/*.json), available for inspection and direct download:',
                        '本官网与扩展同源（src/providers/config/*.json）发布提供商模型配置，可直接查阅或下载：'
                    )}
                </p>
                <ul>
                    <li>
                        {t('Config manifest: ', '配置清单：')}
                        <code>/configs/index.json</code>
                        {t(
                            ' (includes GCMP version, generation time, provider list)',
                            '（含 GCMP 版本、生成时间、提供商清单）'
                        )}
                    </li>
                    <li>
                        {t('Per-provider config: ', '单提供商配置：')}
                        <code>/configs/&lt;providerId&gt;.json</code>
                        {t(', e.g. ', '，例如')}
                        <a href="/configs/zhipu.json" target="_blank" rel="noreferrer">
                            /configs/zhipu.json
                        </a>
                    </li>
                </ul>
                <pre>
                    <code>{`{
  "schemaVersion": 1,
  "gcmpVersion": "0.27.15-p1",
  "generatedAt": "2026-09-06T00:00:00.000Z",
  "providers": [
    { "id": "zhipu", "displayName": "ZhipuAI", "modelCount": 8 },
    ...
  ]
}`}</code>
                </pre>
                <p className="muted">
                    {t('Configs are published as-is from ', '配置由扩展仓库的 ')}
                    <code>src/providers/config/*.json</code>
                    {t(
                        ' via sync script on every deployment, staying consistent with the bundled extension configs.',
                        ' 经同步脚本原样发布，每次部署与扩展内置配置保持一致。'
                    )}
                </p>
            </section>

            <section className="card">
                <h2>{t('Related Links', '相关链接')}</h2>
                <ul>
                    <li>
                        <a href="https://github.com/VicBilibily/GCMP" target="_blank" rel="noreferrer">
                            {t('GitHub Repository', 'GitHub 仓库')}
                        </a>
                    </li>
                    <li>
                        <a
                            href="https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp"
                            target="_blank"
                            rel="noreferrer"
                        >
                            {t('VS Code Marketplace', 'VS Code 扩展市场')}
                        </a>
                    </li>
                    <li>
                        <a href="/models">{t('Built-in Providers & Models', '内置提供商与模型列表')}</a>
                    </li>
                </ul>
            </section>
        </>
    );
}
