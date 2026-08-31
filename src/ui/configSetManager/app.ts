/*---------------------------------------------------------------------------------------------
 *  Config Set Manager WebView 前端入口
 *  布局：左侧提供商导航 + 右侧详情面板（每个槽位独立管理配置）
 *  组件已拆分至 components/ 目录，本文件仅保留 render 与消息分发
 *--------------------------------------------------------------------------------------------*/

import './style.less';
import type { HostMessage } from './types';
import {
    state,
    el,
    t,
    getConfigUsageKey,
    ensureSelection,
    requestUsageForSelection,
    showMessage,
    clearMessage,
    postToVSCode
} from './components/state';
import { mergeConfigUsageState, mergeCliUsageState } from './components/usage';
import { initCards } from './components/cards';
import {
    initDialogs,
    renderDeleteDialog,
    renderDeactivateDialog,
    renderCliRemoveDialog,
    renderPassphraseDialog,
    renderRestoreDialog,
    renderUploadDialog,
    renderActiveKeysDialog,
    renderRemoteConfigsDialog
} from './components/dialogs';
import { initSidebar, renderSidebar } from './components/sidebar';
import { initDetail, renderDetail } from './components/detail';
import { renderHeader, syncGistMenuPopover } from './components/header';

// ============= 初始化组件依赖 =============

initCards({ render, renderDeleteDialog, renderDeactivateDialog });
initDialogs({ render });
initSidebar({ render });
initDetail({ render, showMessage, renderCliRemoveDialog });

// ============= 渲染 =============

function render(): void {
    const app = document.getElementById('app');
    if (!app) {
        return;
    }
    ensureSelection();

    // 首次构建整体骨架：header + message-bar + main{sidebar + detail}
    // 后续 render 只替换各容器的子节点，保留容器本身，避免滚动位置丢失与整页闪烁。
    let main = app.querySelector(':scope > .csm-main') as HTMLElement | null;
    if (!main) {
        app.innerHTML = '';
        app.appendChild(renderHeader(render));
        app.appendChild(el('div', 'csm-message-bar'));
        main = el('div', 'csm-main');
        main.appendChild(el('nav', 'csm-sidebar'));
        main.appendChild(el('section', 'csm-detail'));
        app.appendChild(main);
    }

    // header 不滚动，整体替换即可（按钮 disabled / spinner 依赖 busy 状态）
    const oldHeader = app.querySelector(':scope > header.csm-header');
    if (oldHeader) {
        oldHeader.replaceWith(renderHeader(render));
    }

    // Gist 菜单弹层独立于 header（body 级），按 gistMenuOpen 同步创建/销毁
    syncGistMenuPopover(render);

    // sidebar 保留容器与滚动位置，仅替换子节点（事件随节点移动保留）
    const sidebar = main.querySelector(':scope > .csm-sidebar') as HTMLElement | null;
    if (sidebar) {
        const savedScroll = sidebar.scrollTop;
        const newSidebar = renderSidebar();
        sidebar.replaceChildren(...Array.from(newSidebar.children));
        sidebar.scrollTop = savedScroll;
    }

    // detail 保留容器，仅替换子节点；保存滚动位置并在重建后恢复
    const detail = main.querySelector(':scope > .csm-detail') as HTMLElement | null;
    if (detail) {
        const savedScroll = detail.scrollTop;
        const newDetail = renderDetail();
        detail.replaceChildren(...Array.from(newDetail.children));
        // 内容重建后恢复滚动；若新内容更短会被浏览器自动 clamp
        detail.scrollTop = savedScroll;
    }

    if (state.busy) {
        showMessage('info', t('Working...', '处理中...'));
    }
}

// ============= 消息处理 =============

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
    const msg = event.data;
    switch (msg.command) {
        case 'init':
            state.providers = msg.providers;
            state.states = msg.states;
            state.cliProviders = msg.cliProviders;
            state.configUsages = {};
            state.syncState = msg.syncState;
            state.busy = false;
            state.addFormDraft = null;
            state.editFormDraft = null;
            state.reloadUsageOnNextStates = false;
            if (msg.initialProvider) {
                state.selectedProvider = msg.initialProvider;
            }
            if (msg.states.every(s => s.slots.every(slot => slot.rows.length === 0))) {
                const firstSlot = msg.states[0]?.slots[0];
                if (firstSlot) {
                    state.addFormSlot = firstSlot.slot;
                }
            }
            render();
            requestUsageForSelection();
            return;
        case 'selectProvider':
            state.selectedProvider = msg.provider;
            state.addFormSlot = null;
            state.editFormKey = null;
            clearMessage();
            render();
            requestUsageForSelection();
            return;
        case 'states': {
            const shouldReloadUsage = state.reloadUsageOnNextStates;
            state.states = msg.states;
            state.busy = false;
            state.reloadUsageOnNextStates = false;
            render();
            if (shouldReloadUsage) {
                requestUsageForSelection();
            }
            return;
        }
        case 'cliProviders':
            state.cliProviders = msg.cliProviders;
            render();
            return;
        case 'cliUsage': {
            const target = state.cliProviders.find(c => c.provider === msg.provider);
            if (target) {
                target.usage = mergeCliUsageState(target.usage, msg.usage);
            }
            render();
            return;
        }
        case 'configUsages':
            for (const usage of msg.configUsages) {
                const usageKey = getConfigUsageKey(usage.slot, usage.id);
                state.configUsages[usageKey] = mergeConfigUsageState(state.configUsages[usageKey], usage);
            }
            render();
            return;
        case 'addResult':
            state.busy = false;
            if (msg.ok) {
                state.addFormSlot = null;
                state.addFormDraft = null;
            } else {
                state.reloadUsageOnNextStates = false;
            }
            render();
            showMessage(msg.ok ? '' : 'error', msg.error);
            if (msg.ok && msg.note) {
                showMessage('info', msg.note);
            }
            return;
        case 'applyResult':
            state.busy = false;
            render();
            showMessage(msg.ok ? '' : 'error', msg.error);
            return;
        case 'deactivateResult':
            state.busy = false;
            render();
            showMessage(msg.ok ? '' : 'error', msg.error);
            if (msg.ok && msg.note) {
                showMessage('info', msg.note);
            }
            return;
        case 'editResult':
            state.busy = false;
            if (msg.ok) {
                state.editFormKey = null;
                state.editFormDraft = null;
            } else {
                state.reloadUsageOnNextStates = false;
            }
            render();
            showMessage(msg.ok ? '' : 'error', msg.error);
            if (msg.ok && msg.note) {
                showMessage('info', msg.note);
            }
            return;
        case 'removeResult':
            state.busy = false;
            render();
            showMessage(msg.ok ? '' : 'error', msg.error);
            if (msg.ok && msg.note) {
                showMessage('info', msg.note);
            }
            return;
        case 'uploadPrep':
            state.uploadSnapshots = msg.snapshots;
            state.uploadRemoteReadable = msg.remoteReadable;
            if (msg.warning) {
                showMessage('warning', msg.warning);
            }
            renderUploadDialog();
            return;
        case 'uploadResult':
            state.busy = false;
            state.uploadSnapshots = null;
            if (msg.warning) {
                showMessage('warning', msg.warning);
            }
            if (!msg.ok) {
                showMessage('error', msg.error);
            } else {
                showMessage(
                    'info',
                    msg.uploadedCount !== undefined ?
                        t('Uploaded {0} configuration(s)', '已上传 {0} 项配置', msg.uploadedCount)
                    :   t('Uploaded successfully', '上传成功')
                );
            }
            return;
        case 'requestPassphrase':
            state.busy = false;
            render();
            renderPassphraseDialog(msg.error);
            return;
        case 'downloadPrep':
            state.restoreSnapshots = msg.snapshots;
            if (msg.warning) {
                showMessage('warning', msg.warning);
            }
            renderRestoreDialog();
            return;
        case 'clearRestorePrep':
            state.restoreSnapshots = null;
            document.querySelector('.csm-restore-overlay')?.remove();
            render();
            return;
        case 'downloadResult':
            state.busy = false;
            state.restoreSnapshots = null;
            if (!msg.ok) {
                state.reloadUsageOnNextStates = false;
            }
            render();
            if (!msg.ok) {
                showMessage('error', msg.error);
            } else if (msg.appliedCount !== undefined) {
                showMessage('info', t('Restored {0} slot(s)', '已恢复 {0} 个槽位', msg.appliedCount));
            }
            return;
        case 'activeKeysPrep':
            state.activeSnapshots = msg.snapshots;
            renderActiveKeysDialog();
            return;
        case 'activeKeysResult':
            state.busy = false;
            state.activeSnapshots = null;
            render();
            if (!msg.ok) {
                showMessage('error', msg.error);
            } else {
                showMessage(
                    'info',
                    msg.changedCount ?
                        t('Applied {0} change(s)', '已应用 {0} 处变更', msg.changedCount)
                    :   t('No changes', '无变更')
                );
            }
            return;
        case 'remoteConfigsPrep':
            state.remoteSnapshots = msg.snapshots;
            if (msg.warning) {
                showMessage('warning', msg.warning);
            }
            renderRemoteConfigsDialog();
            return;
        case 'remoteConfigsResult':
            state.busy = false;
            state.remoteSnapshots = null;
            if (!msg.ok) {
                showMessage('error', msg.error);
            } else {
                showMessage(
                    'info',
                    msg.removedCount ?
                        t('Removed {0} remote configuration(s)', '已删除 {0} 项远端配置', msg.removedCount)
                    :   t('No changes', '无变更')
                );
            }
            return;
        case 'syncStatus':
            state.busy = msg.busy;
            if (!msg.busy) {
                // busy 结束清掉"处理中"；随后的结果消息会覆盖，对话框类流程则保持干净
                clearMessage();
            }
            render();
            return;
        case 'syncState':
            state.syncState = msg.syncState;
            render();
            return;
    }
});

// ============= 启动 =============

postToVSCode({ command: 'ready' });
