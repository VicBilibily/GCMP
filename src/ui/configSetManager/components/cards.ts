/*---------------------------------------------------------------------------------------------
 *  Config Set Manager - 配置卡片渲染
 *  renderSlotCards / renderAddForm / renderEditForm
 *--------------------------------------------------------------------------------------------*/

import type { SlotState, ConfigSetRow, ProviderOption } from '../types';
import { el, t, state, getConfigMetricType, postToVSCode, showMessage, clearMessage } from './state';
import { renderConfigUsage } from './usage';

// ============= Slot 配置卡片列表 =============

export function renderSlotCards(slotState: SlotState): HTMLElement {
    const list = el('div', 'csm-card-list');
    for (const row of slotState.rows) {
        const editKey = `${slotState.slot}:${row.id}`;
        const isEditing = state.editFormKey === editKey;
        const usageState =
            state.configUsages[editKey] ??
            (slotState.hasUsage ?
                {
                    slot: slotState.slot,
                    id: row.id,
                    supported: true,
                    metricType: slotState.usageMetricType ?? getConfigMetricType(slotState.slot),
                    queued: true,
                    loading: false
                }
            :   undefined);
        const card = el('article', 'csm-config-card');

        if (isEditing) {
            card.appendChild(renderEditForm(slotState, row));
            list.appendChild(card);
            continue;
        }

        // 头部：别称 + 使用中徽标
        const head = el('div', 'csm-config-card-head');
        const titleWrap = el('div', 'csm-config-card-titlewrap');
        titleWrap.appendChild(el('span', 'csm-config-card-title', row.label));
        head.appendChild(titleWrap);
        if (row.isActive) {
            head.appendChild(el('span', 'csm-config-card-badge', t('In use', '使用中')));
        }
        card.appendChild(head);

        // 内容区：元信息（站点、备注等，预留余额/订阅状态）
        const metaItems: Array<{ label: string; value: string }> = [];
        if (row.siteLabel) {
            metaItems.push({ label: t('Site', '站点'), value: row.siteLabel });
        }
        if (row.note) {
            metaItems.push({ label: t('Note', '备注'), value: row.note });
        }
        if (metaItems.length > 0 || usageState?.supported) {
            const body = el('div', 'csm-config-card-body');
            for (const item of metaItems) {
                const meta = el('div', 'csm-config-meta-item');
                meta.appendChild(el('div', 'csm-config-meta-label', item.label));
                const value = el('div', 'csm-config-meta-value', item.value);
                value.title = item.value;
                meta.appendChild(value);
                body.appendChild(meta);
            }
            if (usageState?.supported) {
                body.appendChild(renderConfigUsage(slotState, row, usageState));
            }
            card.appendChild(body);
        }

        // 底部：操作区
        const footer = el('div', 'csm-config-card-footer');
        if (row.isActive) {
            const deactivateBtn = el('button', 'csm-btn csm-btn-sm', t('Deactivate', '停用'));
            deactivateBtn.disabled = state.busy;
            deactivateBtn.title = t(
                'Clear the active API key; the saved configuration is kept.',
                '清除当前生效的 API Key；已保存的配置保留。'
            );
            deactivateBtn.addEventListener('click', () => {
                clearMessage();
                renderDeactivateDialog(slotState, row, () => {
                    state.busy = true;
                    render();
                    postToVSCode({ command: 'deactivate', slot: slotState.slot });
                });
            });
            footer.appendChild(deactivateBtn);
        } else {
            const applyBtn = el('button', 'csm-btn csm-btn-sm csm-btn-primary', t('Activate', '激活'));
            applyBtn.disabled = state.busy;
            applyBtn.addEventListener('click', () => {
                clearMessage();
                state.busy = true;
                render();
                postToVSCode({ command: 'apply', slot: slotState.slot, id: row.id });
            });
            footer.appendChild(applyBtn);
        }
        const editBtn = el('button', 'csm-btn csm-btn-sm', t('Edit', '修改'));
        editBtn.disabled = state.busy;
        editBtn.addEventListener('click', () => {
            if (state.editFormKey !== editKey) {
                state.editFormDraft = null;
            }
            state.editFormKey = editKey;
            clearMessage();
            render();
        });
        footer.appendChild(editBtn);
        const removeBtn = el('button', 'csm-btn csm-btn-sm csm-btn-danger', t('Delete', '删除'));
        removeBtn.disabled = state.busy;
        removeBtn.addEventListener('click', () => {
            clearMessage();
            renderDeleteDialog(slotState, row);
        });
        footer.appendChild(removeBtn);
        card.appendChild(footer);

        list.appendChild(card);
    }
    return list;
}

// ============= 新增表单 =============

export function renderAddForm(slotState: SlotState, opt: ProviderOption | undefined): HTMLElement {
    const panel = el('div', 'csm-add-panel');
    const draft = state.addFormDraft?.slot === slotState.slot ? state.addFormDraft : null;

    const slotRow = el('div', 'csm-field');
    slotRow.appendChild(el('label', '', t('Slot', '槽位')));
    slotRow.appendChild(el('span', 'csm-field-static', slotState.displayName));
    panel.appendChild(slotRow);

    const labelRow = el('div', 'csm-field');
    labelRow.appendChild(el('label', '', t('Name', '名称')));
    const labelInput = el('input', 'csm-input') as HTMLInputElement;
    labelInput.type = 'text';
    labelInput.placeholder = t('e.g. Work, Personal', '如：工作号、个人号');
    labelInput.value = draft?.label ?? '';
    labelRow.appendChild(labelInput);
    panel.appendChild(labelRow);

    // 站点选择（仅主槽位且提供商支持站点切换）
    let siteSelect: HTMLSelectElement | null = null;
    if (slotState.hasSite && opt?.hasSite && opt.sites && opt.sites.length > 0) {
        const siteRow = el('div', 'csm-field');
        siteRow.appendChild(el('label', '', t('Site', '站点')));
        siteSelect = el('select', 'csm-select') as HTMLSelectElement;
        for (const s of opt.sites) {
            const o = el('option', '', s.label) as HTMLOptionElement;
            o.value = s.value;
            siteSelect.appendChild(o);
        }
        if (draft?.site) {
            siteSelect.value = draft.site;
        }
        siteRow.appendChild(siteSelect);
        panel.appendChild(siteRow);
    }

    const keyRow = el('div', 'csm-field');
    keyRow.appendChild(el('label', '', 'API Key'));
    const keyInput = el('input', 'csm-input') as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.placeholder = opt?.apiKeyTemplate ?? 'API Key';
    keyInput.value = draft?.apiKey ?? '';
    keyRow.appendChild(keyInput);
    panel.appendChild(keyRow);

    const noteRow = el('div', 'csm-field');
    noteRow.appendChild(el('label', '', t('Note', '备注')));
    const noteInput = el('input', 'csm-input') as HTMLInputElement;
    noteInput.type = 'text';
    noteInput.placeholder = t(
        'Optional note (synced to Gist in plaintext)',
        '可选备注（同步至 Gist 时为明文，勿填敏感信息）'
    );
    noteInput.value = draft?.note ?? '';
    noteRow.appendChild(noteInput);
    panel.appendChild(noteRow);

    const syncAddDraft = (): void => {
        state.addFormDraft = {
            slot: slotState.slot,
            label: labelInput.value,
            note: noteInput.value,
            apiKey: keyInput.value,
            site: siteSelect?.value || undefined
        };
    };
    labelInput.addEventListener('input', syncAddDraft);
    keyInput.addEventListener('input', syncAddDraft);
    noteInput.addEventListener('input', syncAddDraft);
    siteSelect?.addEventListener('change', syncAddDraft);

    const actions = el('div', 'csm-add-actions');
    const cancelBtn = el('button', 'csm-btn csm-btn-sm', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => {
        state.addFormSlot = null;
        state.addFormDraft = null;
        render();
    });
    const confirmBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Add', '添加'));
    confirmBtn.disabled = state.busy;
    confirmBtn.addEventListener('click', () => {
        const label = labelInput.value.trim();
        const apiKey = keyInput.value.trim();
        const note = noteInput.value.trim() || undefined;
        const site = siteSelect && siteSelect.value ? siteSelect.value : undefined;
        if (!label || !apiKey) {
            showMessage('warning', t('Name and API key are required', '请填写名称和 API Key'));
            return;
        }
        clearMessage();
        state.reloadUsageOnNextStates = true;
        state.busy = true;
        render();
        postToVSCode({ command: 'add', slot: slotState.slot, label, note, site, apiKey });
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    return panel;
}

// ============= 编辑表单 =============

export function renderEditForm(slotState: SlotState, row: ConfigSetRow): HTMLElement {
    const panel = el('div', 'csm-edit-panel');
    const editKey = `${slotState.slot}:${row.id}`;
    const draft = state.editFormDraft?.key === editKey ? state.editFormDraft : null;

    const labelRow = el('div', 'csm-field');
    labelRow.appendChild(el('label', '', t('Name', '名称')));
    const labelInput = el('input', 'csm-input') as HTMLInputElement;
    labelInput.type = 'text';
    labelInput.value = draft?.label ?? row.label;
    labelRow.appendChild(labelInput);
    panel.appendChild(labelRow);

    const keyRow = el('div', 'csm-field');
    keyRow.appendChild(el('label', '', 'API Key'));
    const keyInput = el('input', 'csm-input') as HTMLInputElement;
    keyInput.type = 'password';
    keyInput.placeholder = t('Leave empty to keep current key', '留空保持不变');
    keyInput.value = draft?.apiKey ?? '';
    keyRow.appendChild(keyInput);
    panel.appendChild(keyRow);

    const noteRow = el('div', 'csm-field');
    noteRow.appendChild(el('label', '', t('Note', '备注')));
    const noteInput = el('input', 'csm-input') as HTMLInputElement;
    noteInput.type = 'text';
    noteInput.value = draft?.note ?? row.note ?? '';
    noteInput.placeholder = t(
        'Optional note (synced to Gist in plaintext)',
        '可选备注（同步至 Gist 时为明文，勿填敏感信息）'
    );
    noteRow.appendChild(noteInput);
    panel.appendChild(noteRow);

    const syncEditDraft = (): void => {
        state.editFormDraft = {
            key: editKey,
            label: labelInput.value,
            note: noteInput.value,
            apiKey: keyInput.value
        };
    };
    labelInput.addEventListener('input', syncEditDraft);
    keyInput.addEventListener('input', syncEditDraft);
    noteInput.addEventListener('input', syncEditDraft);

    const actions = el('div', 'csm-add-actions');
    const cancelBtn = el('button', 'csm-btn csm-btn-sm', t('Cancel', '取消'));
    cancelBtn.addEventListener('click', () => {
        state.editFormKey = null;
        state.editFormDraft = null;
        render();
    });
    const saveBtn = el('button', 'csm-btn csm-btn-primary csm-btn-sm', t('Save', '保存'));
    saveBtn.disabled = state.busy;
    saveBtn.addEventListener('click', () => {
        const label = labelInput.value.trim();
        const note = noteInput.value.trim();
        const apiKey = keyInput.value.trim() || undefined;
        if (!label) {
            showMessage('warning', t('Name is required', '请填写名称'));
            return;
        }
        clearMessage();
        state.reloadUsageOnNextStates = apiKey !== undefined;
        state.busy = true;
        render();
        postToVSCode({ command: 'edit', slot: slotState.slot, id: row.id, label, note, apiKey });
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    panel.appendChild(actions);

    return panel;
}

// ============= 外部依赖（由 app.ts 注入） =============

let render: () => void = () => {};
let renderDeleteDialog: (slotState: SlotState, row: ConfigSetRow) => void = () => {};
let renderDeactivateDialog: (slotState: SlotState, row: ConfigSetRow, onConfirm: () => void) => void = () => {};

export function initCards(deps: {
    render: () => void;
    renderDeleteDialog: (slotState: SlotState, row: ConfigSetRow) => void;
    renderDeactivateDialog: (slotState: SlotState, row: ConfigSetRow, onConfirm: () => void) => void;
}): void {
    render = deps.render;
    renderDeleteDialog = deps.renderDeleteDialog;
    renderDeactivateDialog = deps.renderDeactivateDialog;
}
