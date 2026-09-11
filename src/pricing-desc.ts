/**
 * 共享展示工具：价格格式化 + schedule 中文描述。
 * 供 builder / format / 命令层复用，保持"同一价格 → 同一文案"。
 */

import type { Schedule } from "./pricing-types.ts";

/** 格式化单个价格（¥1 → "¥1.00"；¥0.02 → "¥0.02"） */
export function price(n: number): string {
	return `¥${n.toFixed(2)}`;
}

/** 校验价格输入：支持 "4"、"4.5"、"¥0.02"；非法或负数返回 null */
export function parsePriceInput(raw: string): number | null {
	const cleaned = raw.replace(/^¥/, "").trim();
	const num = Number(cleaned);
	if (!Number.isFinite(num) || num < 0) return null;
	return num;
}

/**
 * 校验日历日期：形状（YYYY-MM-DD | MM-DD）+ 真实范围（月份 1-12，日按月份）。
 * 仅用正则匹配形状会放过 2026-13-99 这类"形状正确但不存在"的日期。
 */
export function isValidCalendarDate(raw: string): boolean {
	const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(raw);
	if (!m) return false;
	const month = Number(m[1]);
	const day = Number(m[2]);
	if (month < 1 || month > 12) return false;
	// 2 月按闰年上限 29 取，避免误拒合法的 02-29
	const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	return day >= 1 && day <= maxDay;
}

/** 星期数字 → 中文（1=周一张 ... 7=周日） */
export function weekdayCn(w: number): string {
	return ["一", "二", "三", "四", "五", "六", "日"][w - 1] ?? `?${w}`;
}

/** 星期数组 → 中文（[1,2,3,4,5] → "周一至周五"；连续区间缩写） */
export function weekdaysCn(weekdays: number[]): string {
	if (weekdays.length === 0) return "每天";
	const sorted = [...weekdays].sort((a, b) => a - b);
	// 尝试找最长的连续段（简单实现：整段连续则缩写，否则罗列）
	let continuous = true;
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i] !== sorted[i - 1] + 1) continuous = false;
	}
	if (continuous && sorted.length >= 2) {
		return `周${weekdayCn(sorted[0])}至周${weekdayCn(sorted[sorted.length - 1])}`;
	}
	return `周${sorted.map(weekdayCn).join("")}`;
}

/** 时段数组 → 中文（[["09:00","12:00"],["14:00","18:00"]] → "09:00-12:00 / 14:00-18:00"） */
export function rangesCn(ranges: [string, string][]): string {
	if (ranges.length === 0) return "全天";
	return ranges.map(([s, e]) => `${s}-${e}`).join(" / ");
}

/** schedule 的中文一句话总结（"工作日 09:00-12:00 / 14:00-18:00（除节假日）"） */
export function describeSchedule(s: Schedule): string {
	const parts: string[] = [];
	parts.push(weekdaysCn(s.weekdays ?? []));
	parts.push(rangesCn(s.ranges ?? []));
	if (s.calendarMode === "include") parts.push(`（仅 ${s.calendar}）`);
	if (s.calendarMode === "exclude") parts.push(`（除 ${s.calendar}）`);
	if (s.includeDates?.length) parts.push(`（含 ${s.includeDates.join("、")}）`);
	if (s.excludeDates?.length) parts.push(`（除 ${s.excludeDates.join("、")}）`);
	return parts.join(" ").trim();
}