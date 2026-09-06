import { useData } from 'vike-react/useData'
import type { Data } from './+data'
import InstallButton from './InstallButton'
import { useT } from '../../src/i18n'

const FEATURES = [
  {
    enTitle: 'Native Chinese LLMs',
    enDesc:
      'Built-in native providers including ZhipuAI, MiniMax, MoonshotAI, DeepSeek, Alibaba Cloud, Volcengine, Tencent Cloud, and more — ready to use out of the box.',
    zhTitle: '国内原生大模型',
    zhDesc:
      '内置智谱AI、MiniMax、MoonshotAI、DeepSeek、阿里云百炼、火山方舟、腾讯云等原生提供商，开箱即用。'
  },
  {
    enTitle: 'Any Compatible Model',
    enDesc:
      'Compatible with OpenAI and Anthropic API standards. Connect any third-party cloud service model with custom configuration.',
    zhTitle: '任意兼容模型接入',
    zhDesc: '适配 OpenAI 与 Anthropic API 兼容接口，自定义接入任何第三方云服务模型。'
  },
  {
    enTitle: 'Seamless Copilot Chat',
    enDesc:
      'Models appear in the GitHub Copilot Chat model selector — select and start chatting without changing your workflow.',
    zhTitle: '无缝集成 Copilot Chat',
    zhDesc: '模型出现在 GitHub Copilot Chat 模型选择器中，选中即可对话，无需改变使用习惯。'
  },
  {
    enTitle: 'Usage Quota Tracking',
    enDesc:
      'Status bar shows real-time Coding Plan / Token Plan remaining quota, account balance, and expiry date.',
    zhTitle: '套餐用量查询',
    zhDesc: '状态栏实时显示 Coding Plan / Token Plan 周期剩余用量、账户余额与到期时间。'
  },
  {
    enTitle: 'Auxiliary Model Config',
    enDesc:
      'Route background tasks like title generation and commit messages to low-cost models to save your Copilot monthly quota.',
    zhTitle: '辅助模型配置',
    zhDesc: '将标题生成、提交信息等后台实用任务指向低成本模型，节省 Copilot 月度额度。'
  },
  {
    enTitle: 'Web Search Enhancement',
    enDesc:
      'Multiple providers integrate web search tools (e.g. #zhipuWebSearch, #kimiWebSearch) for real-time retrieval during chat.',
    zhTitle: '联网搜索增强',
    zhDesc: '多家提供商集成联网搜索工具（如 #zhipuWebSearch、#kimiWebSearch），对话可实时检索。'
  }
]

const STEPS = [
  {
    enTitle: 'Install Extension',
    enDesc: 'Search and install GCMP in the VS Code Marketplace (extension ID: vicanent.gcmp).',
    zhTitle: '安装扩展',
    zhDesc: '在 VS Code 扩展市场搜索 GCMP 安装（扩展标识 vicanent.gcmp）。'
  },
  {
    enTitle: 'Select Provider',
    enDesc:
      'Open the Copilot Chat panel, select "Manage Models" at the bottom of the model picker, and choose a provider.',
    zhTitle: '选择提供商',
    zhDesc: '打开 Copilot Chat 面板，在模型选择器底部选择「管理模型」，挑选提供商。'
  },
  {
    enTitle: 'Configure API Key',
    enDesc:
      'Follow the prompts to set up your API Key on first use, then return to the model picker to add and enable models.',
    zhTitle: '配置密钥',
    zhDesc: '首次使用按提示完成 API Key 配置，返回模型选择器添加并启用模型。'
  }
]

export default function Page() {
  const data = useData<Data>()
  const t = useT()

  return (
    <>
      <section className="hero">
        <div className="hero-badges">
          <span className="tag tag-on">v{data.gcmpVersion}</span>
          <span className="tag">MIT License</span>
          <span className="tag">
            {data.providerCount} {t('providers', '家提供商')}
          </span>
          <span className="tag">
            {data.modelCount} {t('models', '个模型')}
          </span>
        </div>
        <h1>GCMP · AI Chat Models</h1>
        <p className="hero-sub">
          {t(
            'A VS Code extension that brings multiple native Chinese LLM providers to GitHub Copilot Chat, making your AI coding assistant richer and better suited for local needs.',
            '为 GitHub Copilot Chat 提供多个国内原生大模型提供商支持的 VS Code 扩展，让 AI 编程助手更丰富、更适合本土需求。'
          )}
        </p>
        <div className="hero-actions">
          <InstallButton />
          <a className="btn-secondary" href="/docs">
            {t('Read Docs', '阅读文档')}
          </a>
          <a
            className="btn-secondary"
            href="https://github.com/VicBilibily/GCMP"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </section>

      <section>
        <h2>{t('Core Features', '核心特性')}</h2>
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <div className="card feature-card" key={f.zhTitle}>
              <h3>{t(f.enTitle, f.zhTitle)}</h3>
              <p>{t(f.enDesc, f.zhDesc)}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>{t('Supported Providers', '支持的提供商')}</h2>
        <p className="muted">
          {t(
            `${data.providerCount} native providers, ${data.modelCount} models. Full list at`,
            `共 ${data.providerCount} 家原生提供商、${data.modelCount} 个模型。完整列表见`
          )}
          <a href="/models"> {t('Models', '模型列表')}</a>。
        </p>
        <div className="provider-grid">
          {data.providers.map((p) => (
            <div className="provider-chip" key={p.id}>
              {p.displayName}
              <span className="chip-count">{p.modelCount}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2>{t('Quick Start', '快速开始')}</h2>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.zhTitle}>
              <strong>
                {i + 1}. {t(s.enTitle, s.zhTitle)}
              </strong>
              <p>{t(s.enDesc, s.zhDesc)}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  )
}
