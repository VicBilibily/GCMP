/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 侧栏导航渲染
 *  renderSidebarProviderItem / renderSidebar
 *--------------------------------------------------------------------------------------------*/

import type { ProviderState, CliProviderOption } from '../types';
import { el, t, state, clearMessage, requestUsageForSelection } from './state';

// ============= 提供商侧栏项 =============

export function renderSidebarProviderItem(nav: HTMLElement, pst: ProviderState): void {
    const selected = pst.provider === state.selectedProvider;
    const totalConfigs = pst.slots.reduce((sum, s) => sum + s.rows.length, 0);
    const hasActive = pst.slots.some(s => s.rows.some(r => r.isActive));
    const item = el('button', `csm-side-item${selected ? ' csm-side-item-selected' : ''}`);
    item.appendChild(el('span', 'csm-side-name', pst.displayName));
    const meta = el('span', 'csm-side-meta');
    if (hasActive) {
        const dot = el('span', 'csm-side-dot');
        dot.title = t('Has an active configuration', '有激活中的配置');
        meta.appendChild(dot);
    }
    if (totalConfigs > 0) {
        meta.appendChild(el('span', 'csm-side-count', String(totalConfigs)));
    }
    item.appendChild(meta);
    item.addEventListener('click', () => {
        if (state.selectedProvider !== pst.provider) {
            state.selectedProvider = pst.provider;
            state.addFormSlot = null;
            state.editFormKey = null;
            clearMessage();
            render();
            requestUsageForSelection();
        }
    });
    nav.appendChild(item);
}

// ============= CLI 提供商侧栏项 =============

function renderCliProviderItem(nav: HTMLElement, cli: CliProviderOption): void {
    const key = `cli:${cli.provider}`;
    const selected = key === state.selectedProvider;
    const item = el('button', `csm-side-item${selected ? ' csm-side-item-selected' : ''}`);
    item.appendChild(el('span', 'csm-side-name', cli.displayName));
    const meta = el('span', 'csm-side-meta');
    if (cli.isAuthenticated) {
        const dot = el('span', 'csm-side-dot');
        dot.title = t('Authenticated', '已认证');
        meta.appendChild(dot);
    }
    item.appendChild(meta);
    item.addEventListener('click', () => {
        if (state.selectedProvider !== key) {
            state.selectedProvider = key;
            state.addFormSlot = null;
            state.editFormKey = null;
            clearMessage();
            render();
            requestUsageForSelection();
        }
    });
    nav.appendChild(item);
}

// ============= 侧栏 =============

export function renderSidebar(): HTMLElement {
    const nav = el('nav', 'csm-sidebar');
    const builtinStates = state.states.filter(s => !s.isCustom);
    const customStates = state.states.filter(s => s.isCustom);
    nav.appendChild(el('div', 'csm-side-caption', t('Providers', '提供商')));
    for (const pst of builtinStates) {
        renderSidebarProviderItem(nav, pst);
    }

    // 自定义兼容提供商独立分组
    if (customStates.length > 0) {
        nav.appendChild(el('div', 'csm-side-caption csm-side-caption-group', t('Custom Providers', '自定义提供商')));
        for (const pst of customStates) {
            renderSidebarProviderItem(nav, pst);
        }
    }

    // CLI 认证提供商分组
    if (state.cliProviders.length > 0) {
        nav.appendChild(el('div', 'csm-side-caption csm-side-caption-cli', t('CLI Auth', 'CLI 认证')));
        for (const cli of state.cliProviders) {
            renderCliProviderItem(nav, cli);
        }
    }

    return nav;
}

// ============= 外部依赖（由 app.ts 注入） =============

let render: () => void = () => {};

export function initSidebar(deps: { render: () => void }): void {
    render = deps.render;
}
