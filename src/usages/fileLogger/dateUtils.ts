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

    /**
     * 从日期字符串解析出日期范围(开始和结束时间戳)
     * @param dateStr YYYY-MM-DD 格式的日期字符串
     */
    static parseDateRange(dateStr: string): { start: number; end: number } {
        const date = new Date(dateStr);
        const start = date.getTime();
        const end = start + 86400000 - 1; // 86400000 = 24 * 60 * 60 * 1000
        return { start, end };
    }

    /**
     * 判断两个日期是否是同一天
     */
    static isSameDay(date1: Date, date2: Date): boolean {
        return this.formatDate(date1) === this.formatDate(date2);
    }

    /**
     * 判断是否是今天
     */
    static isToday(date: Date): boolean {
        return this.isSameDay(date, new Date());
    }
}
