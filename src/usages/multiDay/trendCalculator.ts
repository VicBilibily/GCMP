/*---------------------------------------------------------------------------------------------
 *  多天长周期用量分析 - 趋势计算
 *--------------------------------------------------------------------------------------------*/

import type { TrendSeries } from './types';

export class TrendCalculator {
    /** 计算 7 日移动平均 */
    enrich(series: TrendSeries): TrendSeries {
        return { ...series, movingAvg7Day: this.sma(series.totalTokens, 7) };
    }

    /** 简单移动平均 */
    sma(values: number[], window: number): number[] {
        if (values.length === 0) return [];
        const result: number[] = [];
        for (let i = 0; i < values.length; i++) {
            const slice = values.slice(Math.max(0, i - window + 1), i + 1);
            result.push(Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 100) / 100);
        }
        return result;
    }

    /** 本周期 vs 上一等长周期 Token 变化 % */
    calcPeriodOverPeriod(currentTotal: number, previousTotal: number): number {
        if (previousTotal === 0) return currentTotal > 0 ? 100 : 0;
        return Math.round(((currentTotal - previousTotal) / previousTotal) * 10000) / 100;
    }
}
