/**
 * 公共查询函数：resolvePricing() / createPricingResolver()，v2 五注册表解析。
 *
 * 解析语义（对应 AGENTS.md v0.4）：
 * - 绑定数组顺序 = 绑定优先级；方案内规则数组顺序 = 规则优先级；**first match wins**
 * - "剔除"不做成规则类型：更高优先级规则给出结果即覆盖低优先级
 * - 都不命中 → 硬编码兜底价
 * - resolveDebug 返回完整命中/未命中链（/price resolve 调试器）
 */

import type {
	CalendarEntry,
	PricingSchema,
	ResolvedPrice,
	ResolutionDebug,
	ResolutionStep,
	Schedule,
} from "./pricing-types.ts";
import { readPricing } from "./pricing-store.ts";

/** 硬编码兜底价（DeepSeek V4 Flash 谷价，数据来源：09-10 平台账单实测） */
const FALLBACK: ResolvedPrice = {
	inputMiss: 1,
	inputHit: 0.02,
	output: 4,
	isPeak: false,
};

/** 时区换算出的时间信息（一次换算，供所有规则共享） */
interface TzInfo {
	/** "YYYY-MM-DD"（时区日历日） */
	dateKey: string;
	/** "MM-DD"（每年循环用） */
	mmdd: string;
	/** 星期（1=周一 ... 7=周日） */
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
	const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
	const year = get("year");
	let month = get("month");
	let day = get("day");
	if (month.length === 1) month = `0${month}`;
	if (day.length === 1) day = `0${day}`;
	const rawHour = get("hour");
	const hour = rawHour === "24" ? "0" : rawHour;
	const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
	return {
		dateKey: `${year}-${month}-${day}`,
		mmdd: `${month}-${day}`,
		weekday: weekdayMap[get("weekday")] ?? 0,
		minutes: parseInt(hour, 10) * 60 + (parseInt(get("minute"), 10) || 0),
	};
}

/** 日期是否在列表里（"YYYY-MM-DD" 精确 或 "MM-DD" 每年循环） */
function dateInList(list: string[] | undefined, info: TzInfo): boolean {
	if (!list || list.length === 0) return false;
	return list.some((d) => d === info.dateKey || d === info.mmdd);
}

/** 日期是否在日历资源里 */
function dateInCalendar(cal: CalendarEntry, info: TzInfo): boolean {
	return dateInList(cal.dates, info);
}

/** "HH:MM" → 当天分钟数 */
function toMinutes(hhmm: string): number {
	const [h, m] = hhmm.split(":");
	return parseInt(h, 10) * 60 + (parseInt(m, 10) || 0);
}

/** 时段半开区间 [start, end) 判断（跨天需拆成两段，由校验层保证） */
function inRange(minutes: number, start: string, end: string): boolean {
	return minutes >= toMinutes(start) && minutes < toMinutes(end);
}

/** 星期中文显示（调试原因用） */
function weekdayName(w: number): string {
	return ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][w - 1] ?? "";
}

/**
 * 时间条件匹配（确定性优先级）：
 * 1. excludeDates / 日历 exclude → 不命中
 * 2. 日历 include → 命中与否
 * 3. includeDates → 命中（具体日期覆盖周规则）
 * 4. 周规则：weekdays 空 = 任意；ranges 空 = 全天；都空 = always 命中
 */
function matchesSchedule(schedule: Schedule, info: TzInfo, calendars: Record<string, CalendarEntry>): { ok: boolean; reason: string } {
	if (dateInList(schedule.excludeDates, info)) {
		return { ok: false, reason: `排除日期 ${info.dateKey}` };
	}
	const cal = schedule.calendar ? calendars[schedule.calendar] : undefined;
	if (schedule.calendarMode === "exclude" && cal && dateInCalendar(cal, info)) {
		return { ok: false, reason: `日历 ${schedule.calendar} 排除 ${info.dateKey}` };
	}
	if (schedule.calendarMode === "include" && cal) {
		if (dateInCalendar(cal, info)) return { ok: true, reason: `日历 ${schedule.calendar} 命中` };
		return { ok: false, reason: `不在日历 ${schedule.calendar}` };
	}
	if (dateInList(schedule.includeDates, info)) {
		return { ok: true, reason: `includeDates ${info.dateKey}` };
	}
	const wdOk = schedule.weekdays.length === 0 || schedule.weekdays.includes(info.weekday);
	const rgOk = schedule.ranges.length === 0 || schedule.ranges.some(([s, e]) => inRange(info.minutes, s, e));
	if (wdOk && rgOk) {
		return { ok: true, reason: `周规则命中（${weekdayName(info.weekday)}）` };
	}
	const why = !wdOk ? `${weekdayName(info.weekday)} 不在 {${schedule.weekdays.join(",")}}` : "时间不在时段内";
	return { ok: false, reason: why };
}

/** 命中规则是否为"时间窗规则"（有否时段/星期约束；v2 无独立峰谷概念） */
function isTimeWindowed(schedule: Schedule): boolean {
	return schedule.weekdays.length > 0 || schedule.ranges.length > 0;
}

/** 根据价格引用取 ResolvedPrice；引用缺失（脏数据）回退兜底价 */
function priceOf(schema: PricingSchema, priceId: string, schedule: Schedule, info: TzInfo): ResolvedPrice {
	const p = schema.prices[priceId];
	if (!p) return { ...FALLBACK };
	return {
		inputMiss: p.input.miss,
		inputHit: p.input.hit,
		output: p.output,
		isPeak: isTimeWindowed(schedule),
	};
}

/** 在模型列表查找匹配（精确 model id → alias） */
function findModel(models: Record<string, { alias?: string }>, model: string): string | undefined {
	if (model in models) return model;
	for (const [key, val] of Object.entries(models)) {
		if (val.alias === model) return key;
	}
	return undefined;
}

/**
 * 在给定 schema 上按绑定→规则优先级解析；返回价格 + 命中/未命中链。
 * 链 = 按评估顺序排列，遇到第一条 matched=true 即终止。
 */
function resolveSteps(schema: PricingSchema, model: string, provider: string, date: Date): ResolutionDebug {
	const chain: ResolutionStep[] = [];
	const prov = schema.providers[provider];

	if (prov) {
		const matchedModel = findModel(prov.models, model);
		if (matchedModel) {
			const conf = prov.models[matchedModel];
			for (const binding of conf.plans) {
				const planFull = schema.plans[binding.plan];
				if (!binding.enabled) {
					chain.push({ planId: binding.plan, planName: planFull?.name ?? binding.plan, ruleIndex: -1, priceId: "", matched: false, reason: "绑定已禁用" });
					continue;
				}
				if (!planFull) {
					chain.push({ planId: binding.plan, planName: binding.plan, ruleIndex: -1, priceId: "", matched: false, reason: "方案不存在（脏数据）" });
					continue;
				}
				for (let i = 0; i < planFull.rules.length; i++) {
					const rule = planFull.rules[i];
					const info = tzInfo(date, rule.schedule.timezone);
					if (rule.validUntil && info.dateKey > rule.validUntil) {
						chain.push({ planId: binding.plan, planName: planFull.name, ruleIndex: i, priceId: rule.price, matched: false, reason: `规则已过期（有效期至 ${rule.validUntil}）` });
						continue;
					}
					const m = matchesSchedule(rule.schedule, info, schema.calendars);
					const step: ResolutionStep = {
						planId: binding.plan,
						planName: planFull.name,
						ruleIndex: i,
						priceId: rule.price,
						matched: m.ok,
						reason: m.reason,
					};
					chain.push(step);
					if (m.ok) {
						return { price: priceOf(schema, rule.price, rule.schedule, info), chain, matched: true };
					}
				}
			}
		}
	}
	return { price: { ...FALLBACK }, chain, matched: chain.some((s) => s.matched) };
}

/**
 * 解析价格（单次，每次读一次 JSON 文件）。
 * 解析链：模型绑定 → 方案规则 first-match → 硬编码兜底。
 */
export function resolvePricing(
	model: string,
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ResolvedPrice {
	const date = timestamp ?? new Date();
	return resolveSteps(readPricing(filePath), model, provider, date).price;
}

/** 调试解析：返回价格 + 命中/未命中链（/price resolve 用） */
export function resolveDebug(
	model: string,
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ResolutionDebug {
	const date = timestamp ?? new Date();
	return resolveSteps(readPricing(filePath), model, provider, date);
}

/**
 * 批量解析器：一次读取 JSON，返回可复用的 (model, provider, ts) → ResolvedPrice 闭包。
 * 供 pi-prompt / pi-usage 台账逐条调价，避免统计循环里反复磁盘 IO。
 */
export type PricingResolver = (model: string, provider: string, timestamp?: Date | number) => ResolvedPrice;

export function createPricingResolver(filePath?: string): PricingResolver {
	const schema = readPricing(filePath);
	return (model, provider, timestamp) => {
		const date = typeof timestamp === "number" ? new Date(timestamp) : timestamp ?? new Date();
		return resolveSteps(schema, model, provider, date).price;
	};
}

/** 单模型信息（列表/详情/抽屉用） */
export interface ProviderModelInfo {
	/** 平台注册名 */
	model: string;
	alias?: string;
	/** 绑定方案摘要（顺序 = 优先级） */
	planBindings: Array<{ plan: string; planName: string; enabled: boolean }>;
	/** 给定时间点的实时解析价（分组预览用） */
	livePrice: ResolvedPrice;
}

/** 列出某厂商所有模型的绑定与实时价（/price list 与抽屉模型面用） */
export function listProviderModels(
	provider: string,
	timestamp?: Date,
	filePath?: string,
): ProviderModelInfo[] {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return [];
	const date = timestamp ?? new Date();
	return Object.entries(prov.models).map(([model, conf]) => ({
		model,
		alias: conf.alias,
		planBindings: conf.plans.map((b) => ({
			plan: b.plan,
			planName: schema.plans[b.plan]?.name ?? b.plan,
			enabled: b.enabled,
		})),
		livePrice: resolveSteps(schema, model, provider, date).price,
	}));
}

/** 获取所有 provider id */
export function listProviders(filePath?: string): string[] {
	const schema = readPricing(filePath);
	return Object.keys(schema.providers);
}