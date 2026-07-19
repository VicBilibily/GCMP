import { t } from '../../usagesView/utils';
import { createElement } from '../../utils';

const QUICK_RANGES = [7, 14, 30] as const;

const pickerState = { dateFrom: '', dateTo: '', selectedQuick: 0 };

export function createDateRangePicker(): HTMLElement {
    const row = createElement('div', 'quick-range-row');

    for (const days of QUICK_RANGES) {
        const btn = createElement('button', 'quick-range-btn');
        btn.textContent = `${days}D`;
        btn.dataset.days = String(days);
        btn.onclick = () => applyQuickRange(days);
        row.appendChild(btn);
    }

    const sep = createElement('span', 'range-separator');
    sep.textContent = '|';
    row.appendChild(sep);

    const fromInput = createElement('input', 'range-input') as HTMLInputElement;
    fromInput.type = 'date';
    fromInput.id = 'range-date-from';
    fromInput.onchange = () => {
        pickerState.dateFrom = fromInput.value;
        pickerState.selectedQuick = 0;
        updateBtns();
    };
    row.appendChild(fromInput);

    const toLabel = createElement('span', 'range-to-label');
    toLabel.textContent = ' → ';
    row.appendChild(toLabel);

    const toInput = createElement('input', 'range-input') as HTMLInputElement;
    toInput.type = 'date';
    toInput.id = 'range-date-to';
    toInput.onchange = () => {
        pickerState.dateTo = toInput.value;
        pickerState.selectedQuick = 0;
        updateBtns();
    };
    row.appendChild(toInput);

    const analyzeBtn = createElement('button', 'range-analyze-btn');
    analyzeBtn.textContent = t('Analyze', '分析');
    analyzeBtn.onclick = () => {
        const { dateFrom: f, dateTo: t } = pickerState;
        if (f && t && f <= t) {
            window.multiDayState.loading = true;
            window.multiDayRender();
            window.multiDayRequestId += 1;
            window.vscode.postMessage({
                command: 'getMultiDayAnalysis',
                dateFrom: f,
                dateTo: t,
                requestId: window.multiDayRequestId
            });
        }
    };
    row.appendChild(analyzeBtn);

    const container = createElement('div', 'date-range-picker');
    container.appendChild(row);

    // 恢复已选日期到 DOM（render 重建 DOM 后 input 值会丢失）
    if (pickerState.dateFrom) {
        fromInput.value = pickerState.dateFrom;
    }
    if (pickerState.dateTo) {
        toInput.value = pickerState.dateTo;
    }
    updateBtns();

    return container;
}

/** 首次加载时自动选中 7 天并触发分析 */
export function initDefaultRange(): void {
    if (pickerState.dateFrom) {
        return;
    } // 已有选择，不覆盖
    applyQuickRange(7);
}

/**
 * 后台静默重新拉取当前日期范围（不切换 loading 状态，避免已有内容被「加载中」替换而闪烁）。
 * 用于跨实例统计更新晚到时自动刷新，委托超时场景下 Leader 完成重建后展示旧数据的问题。
 */
export function requestCurrentRangeAnalysis(): void {
    const { dateFrom: f, dateTo: t } = pickerState;
    if (!f || !t || f > t) {
        return;
    }
    window.multiDayRequestId += 1;
    window.vscode.postMessage({
        command: 'getMultiDayAnalysis',
        dateFrom: f,
        dateTo: t,
        requestId: window.multiDayRequestId
    });
}

function applyQuickRange(days: number): void {
    const today = new Date();
    const from = new Date(today);
    from.setDate(from.getDate() - days + 1);
    const fmt = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    pickerState.dateFrom = fmt(from);
    pickerState.dateTo = fmt(today);
    pickerState.selectedQuick = days;
    (document.getElementById('range-date-from') as HTMLInputElement).value = pickerState.dateFrom;
    (document.getElementById('range-date-to') as HTMLInputElement).value = pickerState.dateTo;
    updateBtns();
    window.multiDayState.loading = true;
    window.multiDayRender();
    window.multiDayRequestId += 1;
    window.vscode.postMessage({
        command: 'getMultiDayAnalysis',
        dateFrom: pickerState.dateFrom,
        dateTo: pickerState.dateTo,
        requestId: window.multiDayRequestId
    });
}

function updateBtns(): void {
    document.querySelectorAll('.quick-range-btn').forEach(btn => {
        (btn as HTMLElement).classList.toggle(
            'active',
            Number((btn as HTMLElement).dataset.days) === pickerState.selectedQuick
        );
    });
}
