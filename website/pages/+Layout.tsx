import './+Layout.css'
import type { ReactNode } from 'react'
import { usePageContext } from 'vike-react/usePageContext'
import { LocaleProvider, parseAcceptLanguage, useLocale, useSetLocale, useT } from '../src/i18n'

const GCMP_REPO = 'https://github.com/VicBilibily/GCMP'

function LangSwitch() {
  const locale = useLocale()
  const setLocale = useSetLocale()
  const next = locale === 'en' ? 'zh-CN' : 'en'
  const label = locale === 'en' ? '中文' : 'EN'

  return (
    <button
      className="lang-switch"
      onClick={() => setLocale(next)}
      aria-label="Switch language"
    >
      {label}
    </button>
  )
}

function HeaderNav() {
  const t = useT()
  return (
    <nav>
      <a href="/">{t('Home', '首页')}</a>
      <a href="/docs">{t('Docs', '文档')}</a>
      <a href="/models">{t('Models', '模型列表')}</a>
      <a href={GCMP_REPO} target="_blank" rel="noreferrer">
        GitHub
      </a>
      <LangSwitch />
    </nav>
  )
}

export default function Layout({ children }: { children: ReactNode }) {
  const pageContext = usePageContext()
  const serverLocale = parseAcceptLanguage(pageContext.headers?.['accept-language'])

  return (
    <LocaleProvider initialLocale={serverLocale}>
      <div className="site">
        <header className="site-header">
          <a className="brand" href="/">
            GCMP
          </a>
          <HeaderNav />
        </header>
        <main className="site-main">{children}</main>
        <footer className="site-footer">
          <span>
            GCMP · AI Chat Models · MIT License ·{' '}
            <a href={GCMP_REPO} target="_blank" rel="noreferrer">
              VicBilibily/GCMP
            </a>
          </span>
        </footer>
      </div>
    </LocaleProvider>
  )
}
