/*---------------------------------------------------------------------------------------------
 *  日期工具类
 *  统一管理日期格式化和相关操作
 *--------------------------------------------------------------------------------------------*/

/**
 * 日期工具类
 * 提供统一的日期格式化和计算方法
 */
export class DateUtils {
    /**
     * 格式化日期为 YYYY-MM-DD
     * @param date 日期对象
     * @returns 格式化后的日期字符串
     */
    static formatDate(date: Date): string {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }

    /**
     * 获取今日的日期字符串
     */
    static getTodayDateString(): string {
        return this.formatDate(new Date());
    }

    /**
     * 获取指定天数前的日期字符串
     * @param daysAgo 天数前（正数）
     */
    static getDateStringDaysAgo(daysAgo: number): string {
        const date = new Date();
        date.setDate(date.getDate() - daysAgo);
        return this.formatDate(date);
    }
}
