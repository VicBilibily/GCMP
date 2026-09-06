import { useEffect, useRef, useState } from 'react'
import { useT } from '../../src/i18n'

const MARKETPLACE_URL = 'https://marketplace.visualstudio.com/items?itemName=vicanent.gcmp'
const TARGETS = [
  { href: 'vscode:extension/vicanent.gcmp', zh: '安装到 VS Code', en: 'Install in VS Code' },
  {
    href: 'vscode-insiders:extension/vicanent.gcmp',
    zh: '安装到 VS Code Insiders',
    en: 'Install in VS Code Insiders'
  }
]

export default function InstallButton() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 点击菜单外部时收起
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [open])

  return (
    <div className="install-group" ref={ref}>
      <a className="btn" href={MARKETPLACE_URL} target="_blank" rel="noreferrer">
        {t('Install Extension', '安装扩展')}
      </a>
      <button
        className="btn install-caret"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('More install options', '更多安装方式')}
        aria-expanded={open}
      >
        ▾
      </button>
      {open && (
        <div className="install-menu">
          {TARGETS.map((target) => (
            <a key={target.href} href={target.href} onClick={() => setOpen(false)}>
              {t(target.en, target.zh)}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
