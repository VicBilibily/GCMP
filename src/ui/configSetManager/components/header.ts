/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 顶栏渲染
 *  renderHeader（标题 + Gist 菜单触发按钮）
 *  syncGistMenuPopover（body 级菜单弹层，不随 header 重渲染销毁）
 *--------------------------------------------------------------------------------------------*/

import { el, t, state, postToVSCode, clearMessage } from './state';
import type { GistSyncState } from '../types';

const TRIGGER_ID = 'csm-gistmenu-trigger';

export function renderHeader(render: () => void): HTMLElement {
    const header = el('header', 'csm-header');
    const titleWrap = el('div', 'csm-title');
    titleWrap.appendChild(el('h2', '', t('Manage API Keys', 'API Key 管理')));
    titleWrap.appendChild(
        el('span', 'csm-subtitle', t('Unified key management for all providers', '统一管理所有提供商的凭证'))
    );
    header.appendChild(titleWrap);

    const actions = el('div', 'csm-header-actions');
    if (state.busy) {
        actions.appendChild(el('span', 'csm-spinner'));
    }
    const activeBtn = el('button', 'csm-btn csm-btn-sm', t('Active Configs', '生效配置'));
    activeBtn.disabled = state.busy;
    activeBtn.title = t('Switch or revoke the active configuration per slot', '按槽位切换或撤销生效的配置');
    activeBtn.addEventListener('click', () => {
        clearMessage();
        postToVSCode({ command: 'manageActiveKeys' });
    });
    actions.appendChild(activeBtn);
    const trigger = el('button', 'csm-btn csm-btn-sm', t('Gist Sync', 'Gist 同步') + ' ▾');
    trigger.id = TRIGGER_ID;
    trigger.disabled = state.busy;
    trigger.title = t('GitHub Gist sync operations', 'GitHub Gist 同步操作');
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', String(state.gistMenuOpen));
    trigger.addEventListener('click', () => {
        state.gistMenuOpen = !state.gistMenuOpen;
        render();
    });
    actions.appendChild(trigger);
    header.appendChild(actions);
    return header;
}

// ============= Gist 菜单弹层 =============

let overlayEl: HTMLElement | null = null;
let popoverEl: HTMLElement | null = null;
/** 弹层内容对应的 syncState 引用，用于判断是否需要重建内容 */
let popoverSync: GistSyncState | null | undefined;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;

/** 按 state.gistMenuOpen 同步弹层创建/销毁；render() 每次调用 */
export function syncGistMenuPopover(render: () => void): void {
    if (!state.gistMenuOpen) {
        destroyPopover();
        return;
    }
    const trigger = document.getElementById(TRIGGER_ID);
    if (!trigger) {
        state.gistMenuOpen = false;
        destroyPopover();
        return;
    }
    if (!popoverEl) {
        buildPopover(render, trigger);
        return;
    }
    // 仅 syncState 变化时重建内容；其余 render 保留弹层，避免悬停/焦点丢失
    if (popoverSync !== state.syncState) {
        fillPopover(render, popoverEl);
    }
}

function buildPopover(render: () => void, trigger: HTMLElement): void {
    overlayEl = el('div', 'csm-gistmenu-overlay');
    overlayEl.addEventListener('click', () => {
        state.gistMenuOpen = false;
        render();
    });
    document.body.appendChild(overlayEl);

    popoverEl = el('div', 'csm-gistmenu-pop');
    popoverEl.setAttribute('role', 'menu');
    popoverEl.setAttribute('aria-labelledby', TRIGGER_ID);
    const rect = trigger.getBoundingClientRect();
    popoverEl.style.top = `${rect.bottom + 4}px`;
    popoverEl.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
    fillPopover(render, popoverEl);
    document.body.appendChild(popoverEl);

    // Escape 关闭并还焦触发按钮；方向键在菜单项间循环
    keyHandler = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
            e.stopPropagation();
            state.gistMenuOpen = false;
            render();
            (document.getElementById(TRIGGER_ID) as HTMLButtonElement | null)?.focus();
            return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const items = Array.from(popoverEl?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
            if (items.length === 0) {
                return;
            }
            e.preventDefault();
            const idx = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
            items[next].focus();
        }
    };
    document.addEventListener('keydown', keyHandler, true);

    popoverEl.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
}

/** 填充菜单内容并记录所用 syncState 快照 */
function fillPopover(render: () => void, pop: HTMLElement): void {
    pop.textContent = '';
    const sync = state.syncState;
    popoverSync = sync;

    // 状态区：账号 / Gist 关联 / 口令
    const statusBox = el('div', 'csm-gistmenu-status');
    statusBox.appendChild(
        el(
            'div',
            'csm-gistmenu-status-line',
            sync?.isLoggedIn ?
                t('GitHub: @{0}', 'GitHub：@{0}', sync.githubUser ?? '')
            :   t('GitHub: not signed in', 'GitHub：未登录')
        )
    );
    const gistText = sync?.hasGist ? t('Gist: linked', 'Gist：已关联') : t('Gist: not linked', 'Gist：未关联');
    const passText =
        sync?.hasCustomPassphrase ?
            t('Passphrase: set', '口令：已设置')
        :   t('Passphrase: not set (recommended)', '口令：未设置（建议先设置）');
    statusBox.appendChild(el('div', 'csm-gistmenu-status-line', `${gistText} · ${passText}`));
    pop.appendChild(statusBox);

    const addItem = (label: string, onClick: () => void): void => {
        const item = el('button', 'csm-gistmenu-item', label);
        item.setAttribute('role', 'menuitem');
        item.addEventListener('click', () => {
            state.gistMenuOpen = false;
            onClick();
            render();
        });
        pop.appendChild(item);
    };

    addItem(t('Upload to Gist', '上传到 Gist'), () => {
        clearMessage();
        postToVSCode({ command: 'upload' });
    });
    addItem(
        sync?.hasGist ? t('Restore from Gist', '从 Gist 恢复') : t('Find / Restore Gist', '查找并恢复 Gist'),
        () => {
            clearMessage();
            postToVSCode({ command: 'download' });
        }
    );
    addItem(t('Manage remote configurations', '管理远端配置'), () => {
        clearMessage();
        postToVSCode({ command: 'manageRemoteConfigs' });
    });
    addItem(t('Migrate legacy Gist data', '迁移旧版 Gist 数据'), () => {
        clearMessage();
        postToVSCode({ command: 'migrateLegacyGist' });
    });
    addItem(t('Legacy key sync (removed in 0.28)', '旧版密钥同步（0.28 移除）'), () => {
        clearMessage();
        postToVSCode({ command: 'openLegacySync' });
    });

    const sep = el('div', 'csm-gistmenu-sep');
    sep.setAttribute('role', 'separator');
    pop.appendChild(sep);

    // 口令管理（原生输入框流程在后端执行）
    addItem(sync?.hasCustomPassphrase ? t('Change Passphrase', '更改口令') : t('Set Passphrase', '设置口令'), () => {
        postToVSCode({ command: 'setPassphrase' });
    });
    if (sync?.hasCustomPassphrase) {
        addItem(t('Clear Passphrase', '清除口令'), () => {
            postToVSCode({ command: 'clearPassphrase' });
        });
    }
}

function destroyPopover(): void {
    overlayEl?.remove();
    popoverEl?.remove();
    overlayEl = null;
    popoverEl = null;
    popoverSync = undefined;
    if (keyHandler) {
        document.removeEventListener('keydown', keyHandler, true);
        keyHandler = null;
    }
}
