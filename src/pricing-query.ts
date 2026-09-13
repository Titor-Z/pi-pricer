/**
 * 解析链：把「厂商+模型+时刻」解析成一条价格（对外稳定 API）。
 *
 * 语义（v5）：
 * - 模型 → 绑定方案（planId，单值）；方案禁用或缺失 → 兜底价
 * - 方案 → 规则集（ruleIds）；按 createdAt 升序评估，**后创建覆盖先创建**
 *   （即交集处由后建规则胜出；无交集则各自生效）
 * - 单条规则匹配 = 各条件的交集：exclude 类先否决，include 类作为 AND 条件，
 *   周/时段为空即不限；全部条件成立才命中
 * - 全程无命中 → 兜底价
 *
 * 对外导出：resolvePricing（单次）/ createPricingResolver（批量闭包）/ resolveDebug（命中链）
 */

import { Database } from "./db/database.ts";
import { compareDocumentOrder } from "./db/document.ts";
import { DEFAULT_PRICING_PATH } from "./pricing-store.ts";
import {
	FALLBACK_PRICE,
	type PricingSchema,
	type ResolvedPrice,
	type ResolutionDebug,
	type ResolutionStep,
	type RuleDoc,
} from "./pricing-types.ts";

/** 时区换算出的时间信息（一次换算，供所有条件共享） */
interface TzInfo {
	/** "YYYY-MM-DD"（时区日历日） */
	dateKey: string;
	/** "MM-DD"（每年循环用） */
	mmdd: string;
	/** 星期（1=周一 … 7=周日） */
	weekday: number;
	/** 当天分钟数（0-1439） */
	minutes: number;
}

/** 换算到目标时区的日历日 / 星期 / 分钟（hour12 修正 24→0） */
function tzInfo(date: Date, timezone: string): TzInfo {
	const fmt = new Intl.DateTimeFormat("en-CA", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
		weekday: "short",
	});
	const parts = fmt.formatToParts(date);
	const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
	const month = get("month").padStart(2, "0");
	const day = get("day").padStart(2, "0");
	const rawHour = get("hour");
	const hour = rawHour === "24" ? "0" : rawHour;
	const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
	return {
		dateKey: `${get("year")}-${month}-${day}`,
		mmdd: `${month}-${day}`,
		weekday: weekdayMap[get("weekday")] ?? 0,
		minutes: parseInt(hour, 10) * 60 + (parseInt(get("minute"), 10) || 0),
	};
}

/** 日期是否命中日期列表（"YYYY-MM-DD" 精确 或 "MM-DD" 每年循环） */
function dateInList(list: string[], info: TzInfo): boolean {
	return list.some((d) => d === info.dateKey || d === info.mmdd);
}

/** 某日历是否包含当前日期 */
function calendarHits(calendarDates: string[], info: TzInfo): boolean {
	return dateInList(calendarDates, info);
}

/** "HH:MM" → 当天分钟数 */
function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":");
	return parseInt(h, 10) * 60 + (parseInt(m, 10) || 0);
}

/** 时段半开区间 [start, end) 判断 */
function inRange(minutes: number, start: string, end: string): boolean {
	return minutes >= toMinutes(start) && minutes < toMinutes(end);
}

/** 星期中文显示（调试原因用） */
function weekdayName(w: number): string {
	return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][w - 1] ?? "";
}

/** 规则是否为"时间窗规则"（带星期/时段约束；用于 isPeak 标注） */
function isTimeWindowed(rule: RuleDoc): boolean {
	return rule.weekdays.length > 0 || rule.ranges.length > 0;
}

/** 规则匹配结果（含未命中原因，供调试链展示） */
interface MatchResult {
	matched: boolean;
	reason: string;
}

/**
 * 单条规则匹配（纯 AND：所有已声明条件都需成立）。
 * 顺序：过期 → 排除日期 → 排除日历 → 包含日历 → 指定日期 → 周/时段。
 */
function matchesRule(rule: RuleDoc, info: TzInfo, calendarsById: Map<string, string[]>): MatchResult {
	if (rule.validUntil !== undefined && info.dateKey > rule.validUntil) {
		return { matched: false, reason: `规则已过期（有效期至 ${rule.validUntil}）` };
	}
	if (dateInList(rule.excludeDates, info)) {
		return { matched: false, reason: `排除日期 ${info.dateKey}` };
	}
	const excluded = rule.excludeCalendars.some((id) => calendarHits(calendarsById.get(id) ?? [], info));
	if (excluded) {
		return { matched: false, reason: "命中排除日历" };
	}
	if (rule.includeCalendars.length > 0) {
		const hit = rule.includeCalendars.some((id) => calendarHits(calendarsById.get(id) ?? [], info));
		if (!hit) return { matched: false, reason: "不在包含日历内" };
	}
	if (rule.includeDates.length > 0 && !dateInList(rule.includeDates, info)) {
		return { matched: false, reason: "不在指定日期内" };
	}
	const weekdayOk = rule.weekdays.length === 0 || rule.weekdays.includes(info.weekday);
	if (!weekdayOk) {
		return { matched: false, reason: `${weekdayName(info.weekday)} 不在 {${rule.weekdays.join(",")}}` };
	}
	const rangeOk = rule.ranges.length === 0 || rule.ranges.some(([s, e]) => inRange(info.minutes, s, e));
	if (!rangeOk) {
		return { matched: false, reason: "时间不在时段内" };
	}
	return { matched: true, reason: "条件全部命中" };
}

/** 由 schema 构造日历 id → 日期列表 的索引 */
function calendarIndex(schema: PricingSchema): Map<string, string[]> {
	return new Map(schema.calendars.map((cal) => [cal._id, cal.dates]));
}

/** 由价格文档组装解析结果（未命中/悬空 → 兜底价） */
function priceFromRate(
	schema: PricingSchema,
	rule: RuleDoc,
	plan: { _id: string; name: string; alias?: string },
): ResolvedPrice {
	const rate = schema.rates.find((r) => r._id === rule.rateId);
	if (!rate) return { ...FALLBACK_PRICE };
	return {
		inputMiss: rate.inputMiss,
		inputHit: rate.inputHit,
		output: rate.output,
		isPeak: isTimeWindowed(rule),
		planId: plan._id,
		planName: plan.name,
		planAlias: plan.alias,
		rateId: rate._id,
		ruleId: rule._id,
	};
}

/**
 * 在给定 schema 上解析：返回价格 + 命中/未命中链。
 * 链按评估顺序排列；由于是"后命中覆盖先命中"，链会完整列出被覆盖的过程。
 */
function resolveSteps(schema: PricingSchema, model: string, provider: string, date: Date): ResolutionDebug {
	const chain: ResolutionStep[] = [];
	const modelDoc = schema.models.find((m) => m.provider === provider && m.model === model);
	if (!modelDoc) {
		return { price: { ...FALLBACK_PRICE }, chain, matched: false };
	}
	// 启用/禁用是**模型级**：只影响当前模型，同方案的其它模型不受影响
	if (modelDoc.enabled === false) {
		chain.push({ ruleId: "", ruleName: "", rateId: "", matched: false, reason: `${provider}/${model} 已禁用` });
		return { price: { ...FALLBACK_PRICE }, chain, matched: false };
	}
	const planDoc = schema.plans.find((p) => p._id === modelDoc.planId);
	if (!planDoc) {
		return { price: { ...FALLBACK_PRICE }, chain, matched: false };
	}

	const calendarsById = calendarIndex(schema);
	// 按创建先后评估（后创建者覆盖先创建者）
	const orderedRules = planDoc.ruleIds
		.map((id) => schema.rules.find((r) => r._id === id))
		.filter((r): r is RuleDoc => r !== undefined)
		.sort(compareDocumentOrder);

	let hit: RuleDoc | undefined;
	for (const rule of orderedRules) {
		const info = tzInfo(date, rule.timezone);
		const result = matchesRule(rule, info, calendarsById);
		chain.push({
			ruleId: rule._id,
			ruleName: rule.name,
			rateId: rule.rateId,
			matched: result.matched,
			reason: result.reason,
		});
		if (result.matched) hit = rule;
	}

	if (!hit) return { price: { ...FALLBACK_PRICE }, chain, matched: false };
	return { price: priceFromRate(schema, hit, planDoc), chain, matched: true };
}

/** 解析价格（单次；每次打开一次数据库） */
export function resolvePricing(
	model: string,
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ResolvedPrice {
	const date = timestamp ?? new Date();
	return resolveSteps(Database.open(filePath).snapshot(), model, provider, date).price;
}

/** 调试解析：返回价格 + 命中/未命中链 */
export function resolveDebug(
	model: string,
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ResolutionDebug {
	const date = timestamp ?? new Date();
	return resolveSteps(Database.open(filePath).snapshot(), model, provider, date);
}

/**
 * 批量解析器：一次读取配置，返回可复用的 (model, provider, ts) → ResolvedPrice 闭包。
 * 供 pi-usager / pi-prompt 台账逐条调价，避免统计循环里反复磁盘 IO。
 */
export type PricingResolver = (model: string, provider: string, timestamp?: Date | number) => ResolvedPrice;

/** 创建批量解析闭包 */
export function createPricingResolver(filePath: string = DEFAULT_PRICING_PATH): PricingResolver {
	const schema = Database.open(filePath).snapshot();
	return (model, provider, timestamp) => {
		const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp ?? new Date();
		return resolveSteps(schema, model, provider, date).price;
	};
}
