/**
 * 公共查询函数：resolvePricing()。
 *
 * 供其他扩展（pi-prompt / pi-usage / 未来组件）import 使用。
 * 解析逻辑：model 别名匹配 → 平台名精确匹配 → provider fallback → 硬编码兜底。
 */

import type { PricingSchema, ProviderPricing, ResolvedPrice } from "./pricing-types.ts";
import { readPricing } from "./pricing-store.ts";

/** 硬编码兜底价（DeepSeek V4 Flash 空闲价，数据来源：09-10 平台账单实测） */
const FALLBACK: ResolvedPrice = {
	inputMiss: 1,
	inputHit: 0.02,
	output: 4,
	isPeak: false,
};

/**
 * 判断给定时间是否处于某厂商的峰时段。
 * - peakHours 为 null → 永远非峰
 * - 星期不匹配 → 非峰
 * - 小时不在任何 ranges 内 → 非峰
 */
function isPeakAtTime(peakHours: ProviderPricing["peakHours"], date: Date): boolean {
	if (!peakHours) return false;

	// 转换到目标时区获取星期和小时
	const tz = peakHours.timezone;
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: tz,
		weekday: "short",
		hour: "numeric",
		hour12: false,
	}).formatToParts(date);

	const weekdayStr = parts.find((p) => p.type === "weekday")?.value ?? "";
	const hourStr = parts.find((p) => p.type === "hour")?.value ?? "0";

	// 星期映射：Mon=1 ... Sun=7（Intl 返回 "Mon"/"Tue"/...）
	const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
	const weekday = weekdayMap[weekdayStr] ?? 0;
	const hour = parseInt(hourStr, 10);

	if (!peakHours.weekdays.includes(weekday)) return false;
	return peakHours.ranges.some(([start, end]) => hour >= start && hour < end);
}

/**
 * 在单个厂商的模型列表中查找匹配的模型。
 * 匹配顺序：精确 model id → alias 匹配。
 */
function findModel(
	models: Record<string, { alias?: string }>,
	model: string,
): string | undefined {
	// 精确匹配
	if (model in models) return model;
	// alias 匹配
	for (const [key, val] of Object.entries(models)) {
		if (val.alias === model) return key;
	}
	return undefined;
}

/**
 * 根据 model/provider/timestamp 解析真实价格。
 *
 * 解析链：JSON 该 model → JSON provider fallback → 硬编码兜底。
 * 返回值含 isPeak 标记，供调用方判断峰谷。
 */
export function resolvePricing(
	model: string,
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ResolvedPrice {
	const schema = readPricing(filePath);
	const providerData = schema.providers[provider];

	// provider 存在 → 尝试匹配 model
	if (providerData) {
		const matchedModel = findModel(providerData.models, model);
		if (matchedModel) {
			const mp = providerData.models[matchedModel];
			const now = timestamp ?? new Date();
			const peak = isPeakAtTime(providerData.peakHours, now);
			const outPrice = peak && mp.output.peak !== null ? mp.output.peak : mp.output.standard;
			return {
				inputMiss: mp.input.miss,
				inputHit: mp.input.hit,
				output: outPrice,
				isPeak: peak,
			};
		}
	}

	// 兜底
	return { ...FALLBACK };
}

/**
 * 获取某厂商所有模型的完整价格列表（/price list 用）。
 * 返回 [平台名, ModelPricing, isPeak][]
 */
export function listProviderModels(
	provider: string,
	timestamp?: Date,
	filePath?: string,
): Array<{ model: string; alias?: string; inputMiss: number; inputHit: number; outputStandard: number; outputPeak: number | null; isPeak: boolean }> {
	const schema = readPricing(filePath);
	const providerData = schema.providers[provider];
	if (!providerData) return [];

	const now = timestamp ?? new Date();
	const peak = isPeakAtTime(providerData.peakHours, now);

	return Object.entries(providerData.models).map(([model, mp]) => ({
		model,
		alias: mp.alias,
		inputMiss: mp.input.miss,
		inputHit: mp.input.hit,
		outputStandard: mp.output.standard,
		outputPeak: mp.output.peak,
		isPeak: peak,
	}));
}

/** 获取所有 provider id */
export function listProviders(filePath?: string): string[] {
	const schema = readPricing(filePath);
	return Object.keys(schema.providers);
}
