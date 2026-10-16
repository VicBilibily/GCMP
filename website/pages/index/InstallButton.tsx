import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../src/i18n';

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp';
const TARGETS = [
    { href: 'vscode:extension/vicanent.gcmp', zh: '安装到 VS Code', en: 'Install in VS Code' },
    {
        href: 'vscode-insiders:extension/vicanent.gcmp',
        zh: '安装到 VS Code Insiders',
        en: 'Install in VS Code Insiders'
    }
];

export default function InstallButton() {
    const t = useT();
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuId = useId();

    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: MouseEvent | FocusEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setOpen(false);
                triggerRef.current?.focus();
            }
        };
        document.addEventListener('click', closeOutside);
        document.addEventListener('focusin', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        ref.current?.querySelector<HTMLAnchorElement>('.install-menu a')?.focus();
        return () => {
            document.removeEventListener('click', closeOutside);
            document.removeEventListener('focusin', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    return (
        <div className="install-group" ref={ref}>
            <a className="btn" href={MARKETPLACE_URL} target="_blank" rel="noreferrer">
                {t('Install Extension', '安装扩展')}
            </a>
            <button
                className="btn install-caret"
                type="button"
                ref={triggerRef}
                onClick={() => setOpen(current => !current)}
                aria-label={t('More install options', '更多安装方式')}
                aria-controls={menuId}
                aria-expanded={open}
            >
                ▾
            </button>
            {open && (
                <div className="install-menu" id={menuId}>
                    {TARGETS.map(target => (
                        <a key={target.href} href={target.href} onClick={() => setOpen(false)}>
                            {t(target.en, target.zh)}
                        </a>
                    ))}
                </div>
            )}
        </div>
    );
}
