/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 详情区渲染
 *  renderDetail / renderCliDetail / renderCliAccountCard / renderSlotSection
 *--------------------------------------------------------------------------------------------*/

import type { ProviderState, SlotState, ProviderOption, CliProviderOption } from '../types';
import { el, t, state, findProviderState, findOption, clearMessage, postToVSCode } from './state';
import { renderCliUsage } from './usage';
import { renderSlotCards, renderAddForm } from './cards';

// ============= 主详情 =============

export function renderDetail(): HTMLElement {
    const detail = el('section', 'csm-detail');

    // CLI 认证提供商详情
    if (state.selectedProvider?.startsWith('cli:')) {
        return renderCliDetail(detail, state.selectedProvider.slice(4));
    }

    const pst = findProviderState(state.selectedProvider ?? '');
    if (!pst) {
        detail.appendChild(el('div', 'csm-empty-detail', t('No provider available', '暂无可用提供商')));
        return detail;
    }
    const opt = findOption(pst.provider);

    // 提供商标题
    const head = el('div', 'csm-detail-head');
    const titleWrap = el('div', 'csm-detail-title');
    titleWrap.appendChild(el('h3', '', pst.displayName));
    const slotCount = pst.slots.length;
    titleWrap.appendChild(el('span', 'csm-detail-count', String(slotCount)));
    head.appendChild(titleWrap);
    detail.appendChild(head);

    // 每个槽位一个分区
    for (const slotState of pst.slots) {
        detail.appendChild(renderSlotSection(pst, slotState, opt));
    }

    return detail;
}

// ============= CLI 详情 =============

export function renderCliDetail(detail: HTMLElement, provider: string): HTMLElement {
    const cli = state.cliProviders.find(c => c.provider === provider);
    if (!cli) {
        detail.appendChild(el('div', 'csm-empty-detail', t('No provider available', '暂无可用提供商')));
        return detail;
    }

    // 标题区：提供商标题
    const head = el('div', 'csm-detail-head');
    const titleWrap = el('div', 'csm-detail-title');
    titleWrap.appendChild(el('h3', '', cli.displayName));
    head.appendChild(titleWrap);
    detail.appendChild(head);

    // 卡片列表：每个账号一张卡（与普通 provider 一致，支持多账号）
    const list = el('div', 'csm-card-list');
    list.appendChild(renderCliAccountCard(cli));
    detail.appendChild(list);

    return detail;
}

// ============= 单个 CLI 账号卡片 =============

function renderCliAccountCard(cli: CliProviderOption): HTMLElement {
    const card = el('article', 'csm-config-card');

    // 头部：账号标识 + 认证状态徽标
    const cardHead = el('div', 'csm-config-card-head');
    const cardTitleWrap = el('div', 'csm-config-card-titlewrap');
    const cardTitleText =
        cli.loading ? t('Checking', '检查中')
        : cli.isAuthenticated ? (cli.usage?.email ?? cli.usage?.planType ?? t('Default', '默认'))
        : t('Not signed in', '未登录');
    cardTitleWrap.appendChild(el('span', 'csm-config-card-title', cardTitleText));
    cardHead.appendChild(cardTitleWrap);
    cardHead.appendChild(
        el(
            'span',
            `csm-cli-status-${
                cli.loading ? 'loading'
                : cli.isAuthenticated ? 'ok'
                : 'warn'
            }`,
            cli.loading ? t('Checking', '检查中')
            : cli.isAuthenticated ? t('Authenticated', '已认证')
            : t('Not authenticated', '未认证')
        )
    );
    card.appendChild(cardHead);

    // 内容区：元信息（grid 多列）+ 余量（跨整行，与普通 provider 一致）
    const cardBody = el('div', 'csm-config-card-body');

    // CLI 安装状态
    const cliInstalledItem = el('div', 'csm-config-meta-item');
    cliInstalledItem.appendChild(el('div', 'csm-config-meta-label', t('CLI Installed', 'CLI 安装')));
    cliInstalledItem.appendChild(
        el(
            'span',
            cli.loading ? 'csm-cli-status-loading'
            : cli.isCliInstalled ? 'csm-cli-status-ok'
            : 'csm-cli-status-warn',
            cli.loading ? t('Checking...', '检查中...')
            : cli.isCliInstalled ? t('Installed', '已安装')
            : t('Not installed', '未安装')
        )
    );
    cardBody.appendChild(cliInstalledItem);

    // 认证状态详情
    const statusItem = el('div', 'csm-config-meta-item');
    statusItem.appendChild(el('div', 'csm-config-meta-label', t('Auth Status', '认证状态')));
    statusItem.appendChild(
        el(
            'span',
            cli.loading ? 'csm-cli-status-loading'
            : cli.isAuthenticated ? 'csm-cli-status-ok'
            : 'csm-cli-status-warn',
            cli.loading ?
                t('Checking CLI status...', '正在检查 CLI 状态...')
            :   (cli.statusDetail ?? (cli.isAuthenticated ? t('Valid', '有效') : t('Not authenticated', '未认证')))
        )
    );
    cardBody.appendChild(statusItem);

    // 余量（与普通 provider 一致，在卡片 body 内跨整行）
    if (cli.usage) {
        cardBody.appendChild(renderCliUsage(cli));
    }

    card.appendChild(cardBody);

    // 说明与引导步骤（跨整行）
    const noteWrap = el('div', 'csm-config-card-note');
    const descText =
        cli.loading ?
            t(
                'CLI status is loading in the background. You can continue using the rest of the panel now.',
                'CLI 状态正在后台加载中，你现在可以先继续使用其余配置面板。'
            )
        : cli.isCliInstalled ?
            cli.isAuthenticated ?
                t(
                    'This provider uses CLI OAuth authentication. Token refresh is handled automatically. Click below to force a refresh.',
                    '此提供商使用 CLI OAuth 认证，令牌自动刷新。点击下方按钮可强制刷新。'
                )
            :   t(
                    'This provider uses CLI OAuth authentication. Please sign in via the CLI first, then click below to import credentials.',
                    '此提供商使用 CLI OAuth 认证。请先通过 CLI 登录，再点击下方按钮导入凭证。'
                )
        :   t(
                'This provider requires a CLI tool that is not installed. Please install "{0}" first.',
                '此提供商需要安装 CLI 工具 "{0}"，请先安装。',
                cli.cliCommand
            );
    noteWrap.appendChild(el('p', 'csm-cli-desc', descText));

    if (!cli.loading && cli.isCliInstalled && !cli.isAuthenticated) {
        const steps = el('div', 'csm-cli-steps');

        const loginStep = el('div', 'csm-cli-step');
        loginStep.appendChild(el('span', 'csm-cli-step-index', '1'));
        loginStep.appendChild(
            el(
                'span',
                'csm-cli-step-text',
                t(
                    'Open a terminal and complete the provider CLI sign-in flow.',
                    '先打开终端，完成该提供商 CLI 的登录流程。'
                )
            )
        );
        steps.appendChild(loginStep);

        const importStep = el('div', 'csm-cli-step');
        importStep.appendChild(el('span', 'csm-cli-step-index', '2'));
        importStep.appendChild(
            el(
                'span',
                'csm-cli-step-text',
                t(
                    'After sign-in finishes, import the logged-in credentials into GCMP.',
                    '登录完成后，再把已登录凭证导入到 GCMP。'
                )
            )
        );
        steps.appendChild(importStep);

        noteWrap.appendChild(steps);
    }
    cardBody.appendChild(noteWrap);

    // 底部：操作按钮
    const footer = el('div', 'csm-config-card-footer');
    if (cli.loading) {
        const checkingBtn = el('button', 'csm-btn csm-btn-sm', t('Checking...', '检查中...'));
        checkingBtn.disabled = true;
        footer.appendChild(checkingBtn);
    } else if (cli.isAuthenticated) {
        const removeBtn = el('button', 'csm-btn csm-btn-sm csm-btn-danger', t('Remove Auth', '移除认证'));
        removeBtn.disabled = state.busy;
        removeBtn.addEventListener('click', () => {
            clearMessage();
            renderCliRemoveDialog(cli.displayName, () => {
                postToVSCode({ command: 'removeCliCredential', provider: cli.provider });
            });
        });
        footer.appendChild(removeBtn);

        const refreshBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Refresh Auth', '刷新认证'));
        refreshBtn.disabled = state.busy;
        refreshBtn.addEventListener('click', () => {
            clearMessage();
            state.busy = true;
            render();
            postToVSCode({ command: 'setupCli', provider: cli.provider });
        });
        footer.appendChild(refreshBtn);
    } else {
        const loginBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Open Terminal & Login', '打开终端登录'));
        loginBtn.disabled = state.busy || !cli.isCliInstalled;
        loginBtn.addEventListener('click', () => {
            clearMessage();
            showMessage(
                'info',
                t(
                    'Terminal opened. Finish CLI sign-in, then click "Import Logged-in Credentials".',
                    '终端已打开，请先完成 CLI 登录，再点击"导入已登录凭证"。'
                )
            );
            postToVSCode({ command: 'openCliTerminal', provider: cli.provider });
        });
        footer.appendChild(loginBtn);

        const importBtn = el('button', 'csm-btn csm-btn-sm', t('Import Logged-in Credentials', '导入已登录凭证'));
        importBtn.disabled = state.busy || !cli.isCliInstalled;
        importBtn.addEventListener('click', () => {
            clearMessage();
            state.busy = true;
            render();
            postToVSCode({ command: 'setupCli', provider: cli.provider });
        });
        footer.appendChild(importBtn);
    }
    card.appendChild(footer);

    return card;
}

// ============= Slot 分区 =============

function renderSlotSection(pst: ProviderState, slotState: SlotState, opt: ProviderOption | undefined): HTMLElement {
    const section = el('div', 'csm-slot-section');

    // 槽位标题栏
    const slotHead = el('div', 'csm-slot-head');
    const slotTitle = el('div', 'csm-slot-title');
    if (slotState.isMain) {
        slotTitle.appendChild(el('span', 'csm-slot-tag-main', t('Main', '主')));
    } else {
        slotTitle.appendChild(el('span', 'csm-slot-tag-variant', t('Variant', '副')));
    }
    slotTitle.appendChild(el('span', 'csm-slot-name', slotState.displayName));
    slotTitle.appendChild(el('span', 'csm-slot-count', String(slotState.rows.length)));
    slotHead.appendChild(slotTitle);

    const addBtn = el(
        'button',
        'csm-btn csm-btn-primary csm-btn-sm',
        state.addFormSlot === slotState.slot ? t('Collapse', '收起') : t('+ Add', '+ 新增')
    );
    addBtn.addEventListener('click', () => {
        const nextAddFormSlot = state.addFormSlot === slotState.slot ? null : slotState.slot;
        if (nextAddFormSlot !== state.addFormSlot) {
            state.addFormDraft = null;
        }
        state.addFormSlot = nextAddFormSlot;
        clearMessage();
        render();
    });
    slotHead.appendChild(addBtn);
    section.appendChild(slotHead);

    const hasRows = slotState.rows.length > 0;
    const body = el('div', 'csm-slot-body');

    // 新增表单
    if (state.addFormSlot === slotState.slot) {
        body.appendChild(renderAddForm(slotState, opt));
    }

    // 配置表格
    if (!hasRows) {
        if (state.addFormSlot !== slotState.slot) {
            const empty = el('div', 'csm-slot-empty');
            empty.appendChild(
                el(
                    'div',
                    'csm-empty-text',
                    t(
                        'No configurations for {0}. Use the add button at the top right to create one.',
                        '"{0}" 暂无配置，请点击右上角"新增"。',
                        slotState.displayName
                    )
                )
            );
            body.appendChild(empty);
        }
    } else {
        body.appendChild(renderSlotCards(slotState));
    }

    section.appendChild(body);

    return section;
}

// ============= 外部依赖（由 app.ts 注入） =============

let render: () => void = () => {};
let showMessage: (kind: 'info' | 'warning' | 'error' | '', text?: string) => void = () => {};
let renderCliRemoveDialog: (displayName: string, onConfirm: () => void) => void = () => {};

export function initDetail(deps: {
    render: () => void;
    showMessage: (kind: 'info' | 'warning' | 'error' | '', text?: string) => void;
    renderCliRemoveDialog: (displayName: string, onConfirm: () => void) => void;
}): void {
    render = deps.render;
    showMessage = deps.showMessage;
    renderCliRemoveDialog = deps.renderCliRemoveDialog;
}
