import './+Layout.css';
import type { ReactNode } from 'react';
import { usePageContext } from 'vike-react/usePageContext';
import { LocaleProvider, parseAcceptLanguage, useLocale, useSetLocale, useT } from '../src/i18n';

const GCMP_REPO = 'https://github.com/VicBilibily/GCMP';

function LangSwitch() {
    const locale = useLocale();
    const setLocale = useSetLocale();
    const t = useT();
    const next = locale === 'en' ? 'zh-CN' : 'en';
    const label = locale === 'en' ? '中文' : 'EN';

    return (
        <button
            className="lang-switch"
            type="button"
            onClick={() => setLocale(next)}
            aria-label={t('Switch to Chinese', '切换为英文')}
            title={t('Switch to Chinese', '切换为英文')}
        >
            {label}
        </button>
    );
}

function HeaderNav() {
    const t = useT();
    const pathname = usePageContext().urlPathname.replace(/\/$/, '') || '/';
    const links = [
        { href: '/', en: 'Home', zh: '首页' },
        { href: '/docs', en: 'Docs', zh: '文档' },
        { href: '/models', en: 'Models', zh: '模型列表' }
    ];

    return (
        <nav aria-label={t('Main navigation', '主导航')}>
            {links.map(link => (
                <a key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined}>
                    {t(link.en, link.zh)}
                </a>
            ))}
            <a href={GCMP_REPO} target="_blank" rel="noreferrer">
                GitHub
            </a>
            <LangSwitch />
        </nav>
    );
}

export default function Layout({ children }: { children: ReactNode }) {
    const pageContext = usePageContext();
    const serverLocale = parseAcceptLanguage(pageContext.headers?.['accept-language']);

    return (
        <LocaleProvider initialLocale={serverLocale}>
            <div className="site">
                <SkipLink />
                <header className="site-header">
                    <a className="brand" href="/">
                        GCMP
                    </a>
                    <HeaderNav />
                </header>
                <main className="site-main" id="main-content" tabIndex={-1}>
                    {children}
                </main>
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
    );
}

function SkipLink() {
    const t = useT();
    return (
        <a className="skip-link" href="#main-content">
            {t('Skip to content', '跳转到正文')}
        </a>
    );
}
