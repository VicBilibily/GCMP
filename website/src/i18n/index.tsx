import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';

export type Locale = 'zh-CN' | 'en';

const STORAGE_KEY = 'gcmp-locale';

// 模块级变量，供 SSR fallback / 非 hook 场景使用
let _locale: Locale = 'zh-CN';

/** 从 Accept-Language 头解析首选语言 */
export function parseAcceptLanguage(header: string | undefined): Locale {
    if (!header) return 'zh-CN';
    // 取 q 值最高的语言标签
    const best = header
        .split(',')
        .map(part => {
            const [tag, qPart] = part.trim().split(';');
            const q = qPart ? parseFloat(qPart.replace('q=', '')) : 1;
            return { tag: tag.trim().toLowerCase(), q };
        })
        .sort((a, b) => b.q - a.q)[0];
    if (!best) return 'zh-CN';
    return best.tag.startsWith('en') ? 'en' : 'zh-CN';
}

// Context 提供绑定当前 locale 的 t() 函数
const TCtx = createContext<(en: string, zh: string) => string>(() => '');
const LocaleCtx = createContext<Locale>('zh-CN');
const SetLocaleCtx = createContext<React.Dispatch<React.SetStateAction<Locale>>>(() => {});

export function LocaleProvider({ children, initialLocale }: { children: ReactNode; initialLocale?: Locale }) {
    // SSR 与客户端首帧统一使用服务端传入的 initialLocale，保证 hydration 一致；
    // 浏览器语言与 localStorage 偏好在 mount 后生效。
    const [locale, setLocale] = useState<Locale>(() => initialLocale ?? 'zh-CN');

    // 客户端挂载后按 手动选择 > 浏览器语言 修正
    useEffect(() => {
        const saved = localStorage.getItem(STORAGE_KEY);
        const preferred =
            saved === 'en' || saved === 'zh-CN' ? saved
            : navigator.language.startsWith('en') ? 'en'
            : 'zh-CN';
        setLocale(prev => (prev !== preferred ? preferred : prev));
    }, []);

    const t = useCallback((en: string, zh: string) => (locale === 'en' ? en : zh), [locale]);

    useEffect(() => {
        _locale = locale;
        localStorage.setItem(STORAGE_KEY, locale);
        document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
    }, [locale]);

    const tMemo = useMemo(() => t, [t]);

    return (
        <TCtx.Provider value={tMemo}>
            <LocaleCtx.Provider value={locale}>
                <SetLocaleCtx.Provider value={setLocale}>{children}</SetLocaleCtx.Provider>
            </LocaleCtx.Provider>
        </TCtx.Provider>
    );
}

/** 内联双语选择（模块级，非 hook 场景 fallback，仅反映初始化时的 locale） */
export function t(en: string, zh: string): string {
    return _locale === 'en' ? en : zh;
}

/** 组件内 hook：获取绑定当前 locale 的 t() — 推荐使用 */
export function useT() {
    return useContext(TCtx);
}

/** 获取当前语言 */
export function useLocale() {
    return useContext(LocaleCtx);
}

/** 设置语言 */
export function useSetLocale() {
    return useContext(SetLocaleCtx);
}
