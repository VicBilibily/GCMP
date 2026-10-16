import './docs.css';
import manifest from '../../public/configs/index.json';
import { useT } from '../../src/i18n';

const SECTIONS = [
    { id: 'introduction', en: 'Introduction', zh: '简介' },
    { id: 'installation', en: 'Installation', zh: '安装' },
    { id: 'quick-start', en: 'Quick Start', zh: '快速开始' },
    { id: 'auxiliary-models', en: 'Auxiliary Models', zh: '辅助模型' },
    { id: 'configs', en: 'Model Configs', zh: '模型配置分发' },
    { id: 'troubleshooting', en: 'Troubleshooting', zh: '常见问题' },
    { id: 'links', en: 'Related Links', zh: '相关链接' }
];

export default function Page() {
    const t = useT();
    const manifestPreview = JSON.stringify({ ...manifest, providers: manifest.providers.slice(0, 2) }, null, 2);

    return (
        <div className="docs-layout">
            <aside className="docs-sidebar">
                <nav aria-label={t('On this page', '本页目录')}>
                    <h2>{t('On this page', '本页目录')}</h2>
                    {SECTIONS.map(section => (
                        <a key={section.id} href={`#${section.id}`}>
                            {t(section.en, section.zh)}
                        </a>
                    ))}
                </nav>
            </aside>
            <article className="docs-content">
                <h1>{t('Documentation', '文档')}</h1>
                <p className="muted">GCMP v{manifest.gcmpVersion}</p>

                <section className="docs-section" id="introduction">
                    <h2>{t('Introduction', '简介')}</h2>
                    <p>
                        {t(
                            'GCMP (AI Chat Models) connects native model providers to the GitHub Copilot Chat model picker. It also supports custom cloud services with OpenAI- and Anthropic-compatible APIs.',
                            'GCMP（AI Chat Models）将原生大模型提供商接入 GitHub Copilot Chat 的模型选择器，也支持通过 OpenAI、Anthropic 兼容接口接入自定义云服务。'
                        )}{' '}
                        <a href="/models">
                            {t(
                                `Browse ${manifest.providers.length} providers and their models.`,
                                `查看 ${manifest.providers.length} 家提供商及其模型。`
                            )}
                        </a>
                    </p>
                </section>

                <section className="docs-section" id="installation">
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
                            <code>vicanent.gcmp</code>
                            {t(').', '）。')}
                        </li>
                        <li>
                            {t(
                                'Prerequisites: VS Code >= 1.138.0, with the GitHub Copilot Chat extension installed.',
                                '前置要求：VS Code >= 1.138.0，并已安装 GitHub Copilot Chat 扩展。'
                            )}
                        </li>
                        <li>
                            {t('Optional code completion: install ', '可选代码补全：按需安装 ')}
                            <a
                                href="https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp-fim-nes"
                                target="_blank"
                                rel="noreferrer"
                            >
                                AI Chat Models - FIM/NES Completion
                            </a>
                            {t(' (extension ID: ', '（扩展标识 ')}
                            <code>vicanent.gcmp-fim-nes</code>
                            {t(
                                '). The main extension does not install it automatically, and chat does not require it.',
                                '）。主扩展不会自动安装补全，聊天功能不依赖补全扩展。'
                            )}
                        </li>
                    </ul>
                    <p>
                        {t(
                            'When upgrading to 0.29.0, manually install the companion from the Marketplace to keep using completion; existing gcmp.fimCompletion.* and gcmp.nesCompletion.* settings and API keys can be reused.',
                            '升级到 0.29.0 后，如需继续使用补全，请在扩展市场手动安装补全扩展；原有 gcmp.fimCompletion.*、gcmp.nesCompletion.* 设置和 API Key 可继续使用。'
                        )}
                    </p>
                </section>

                <section className="docs-section" id="quick-start">
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

                <section className="docs-section" id="auxiliary-models">
                    <h2>{t('Auxiliary Model Configuration (Recommended)', '辅助模型配置（推荐）')}</h2>
                    <p>
                        {t(
                            'GCMP does not override defaults owned by VS Code or other extensions. When utility models are not fully configured and the main-agent fallback is not enabled, startup guidance offers manual configuration or sets chat.byokUtilityModelDefault to mainAgent after you confirm. GCMP commit message generation and vision analysis still require their own model selections:',
                            'GCMP 不会覆盖 VS Code 或其他插件的默认设置。辅助模型未完整配置且未启用跟随主模型时，启动引导会提示手动配置，或由你确认将 chat.byokUtilityModelDefault 设为 mainAgent。GCMP 提交消息生成和视觉分析仍需单独选择模型：'
                        )}
                    </p>
                    <p>
                        {t(
                            'Copilot Harness is not yet fully supported. Startup guidance recommends switching to the default Local Agent only when no related global chat preference has been set; an explicit enabled or disabled setting suppresses the prompt. Changes are saved globally only after confirmation, without changing workspace settings. Existing chats may require starting a new chat and selecting Local Agent again.',
                            'Copilot Harness 暂时未能得到完整支持，仅在尚未设置相关全局聊天偏好时，启动引导才会建议切换到默认的 Local Agent；已有明确的启用或关闭设置时不再提示。仅经你确认后保存全局设置，不修改工作区设置；已有会话可能需要新建并重新选择 Local Agent。'
                        )}
                    </p>
                    <h3>{t('Follow the main chat model', '跟随主聊天模型')}</h3>
                    <pre>
                        <code>{`{
  "chat.byokUtilityModelDefault": "mainAgent"
}`}</code>
                    </pre>
                    <h3>{t('Choose explicit utility models', '单独指定辅助模型')}</h3>
                    <pre>
                        <code>{`{
  // ${t('General utility tasks: title generation, summaries, intent classification, etc.', '通用实用任务：标题生成、摘要、意图分类等')}
  "chat.utilityModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-v4-pro",
  // ${t('Lightweight utility tasks: commit messages, branch names, etc. (fast & low-cost model recommended)', '轻量实用任务：提交信息、分支名等（建议快速低成本模型）')}
    "chat.utilitySmallModel": "gcmp.deepseek/gcmp.deepseek:::deepseek-flash",
  // ${t('GCMP built-in Commit message generation model', 'GCMP 内置 Commit 消息生成模型')}
    "gcmp.commit.model": { "provider": "deepseek", "model": "deepseek-flash" },
  // ${t('GCMP built-in Vision analysis model (must support image input)', 'GCMP 内置视觉分析模型（必须支持图像输入）')}
    "gcmp.vision.model": { "provider": "zhipu", "model": "glm-4.6v-flash" }
}`}</code>
                    </pre>
                    <p>
                        {t('You can also run ', '也可通过命令面板执行 ')}
                        <code>{t('GCMP: Set Auxiliary Preferences', 'GCMP: 设置辅助偏好')}</code>
                        {t(
                            ' from the command palette, or click "Set auxiliary preferences" in the daily stats menu of the status bar Token icon to configure in the visual panel.',
                            '，或在状态栏 Token 消耗图标的每日统计菜单中点击「设置辅助偏好」，在可视化面板统一配置。'
                        )}
                    </p>
                </section>

                <section className="docs-section" id="configs">
                    <h2>{t('Model Config Distribution', '模型配置分发')}</h2>
                    <p>
                        {t(
                            'Published configs start with the extension source (src/providers/config/*.json), then append remote-only models from website/remote-extra. The catalog shows this combined distribution, available for inspection or download:',
                            '官网发布配置以扩展源码（src/providers/config/*.json）为基础，再追加 website/remote-extra 中的仅远端模型。模型库展示合并后的发布内容，可直接查阅或下载：'
                        )}
                    </p>
                    <ul>
                        <li>
                            {t('Config manifest: ', '配置清单：')}
                            <a href="/configs/index.json" target="_blank" rel="noreferrer">
                                <code>/configs/index.json</code>
                            </a>
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
                    <h3>{t('Current manifest excerpt', '当前清单节选')}</h3>
                    <pre>
                        <code>{manifestPreview}</code>
                    </pre>
                    <p className="muted">
                        {t('Configs are published as-is from ', '配置由扩展仓库的 ')}
                        <code>src/providers/config/*.json</code>
                        {t(
                            ' on every deployment. Remote-only additions do not change the bundled source files; the extension receives them through remote metadata updates.',
                            ' 经同步脚本在每次部署时生成。仅远端模型不会改写扩展内置源文件，由扩展通过远端元数据刷新获取。'
                        )}
                    </p>
                </section>

                <section className="docs-section" id="troubleshooting">
                    <h2>{t('Troubleshooting', '常见问题')}</h2>
                    <details className="docs-faq">
                        <summary>
                            {t('Why is a model missing from the picker?', '为什么模型没有出现在选择器中？')}
                        </summary>
                        <p>
                            {t(
                                'Check the VS Code version and that GitHub Copilot Chat is installed. Open Manage Models to add and enable the model, then verify that the selected provider has the correct API key for its API or subscription plan.',
                                '请先确认 VS Code 版本符合要求且已安装 GitHub Copilot Chat，再通过「管理模型」添加并启用模型，并确认提供商使用了对应 API 或订阅套餐的密钥。'
                            )}
                        </p>
                    </details>
                    <details className="docs-faq">
                        <summary>
                            {t(
                                'Why can the catalog differ from the installed extension?',
                                '为什么官网模型列表与已安装扩展不同？'
                            )}
                        </summary>
                        <p>
                            {t(
                                'The catalog includes remote-only models in addition to bundled models. An older extension version or a failed metadata refresh can show a different list. The gcmp.metadata.refresh command requests a fresh remote manifest.',
                                '官网列表包含内置模型和仅远端发布模型。扩展版本较旧或元数据刷新失败时，列表可能不同；可执行 gcmp.metadata.refresh 命令重新请求远端清单。'
                            )}
                        </p>
                    </details>
                    <details className="docs-faq">
                        <summary>
                            {t('Does the main extension include code completion?', '主扩展是否包含代码补全？')}
                        </summary>
                        <p>
                            {t(
                                'Chat and completion are separate extensions. Install vicanent.gcmp-fim-nes when you need FIM or next-edit suggestions; existing gcmp.fimCompletion.* and gcmp.nesCompletion.* settings can be reused.',
                                '聊天与补全由两个独立扩展提供。需要 FIM 或下一步编辑建议时，请安装 vicanent.gcmp-fim-nes；已有 gcmp.fimCompletion.* 和 gcmp.nesCompletion.* 设置可以继续使用。'
                            )}
                        </p>
                    </details>
                </section>

                <section className="docs-section" id="links">
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
                        <li>
                            <a
                                href="https://github.com/VicBilibily/GCMP/blob/main/docs/pricing-tiers-guide.md"
                                target="_blank"
                                rel="noreferrer"
                            >
                                {t('Tiered Pricing Guide', '阶梯定价配置指南')}
                            </a>
                        </li>
                        <li>
                            <a
                                href="https://github.com/VicBilibily/GCMP/blob/main/docs/remote-extra-models-guide.md"
                                target="_blank"
                                rel="noreferrer"
                            >
                                {t('Remote-only Models Guide', '仅远端模型发布指南')}
                            </a>
                        </li>
                    </ul>
                </section>
            </article>
        </div>
    );
}
