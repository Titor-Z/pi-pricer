/**
 * 数据校验与引用保护：提交事务前统一运行，保证落盘数据自洽。
 *
 * 两类职责：
 * 1. validateSchema(schema) —— 全量校验（_id 格式/唯一、name 唯一、外键存在、日期时段格式）
 * 2. checkXDeletable(schema, id) —— 删除保护（被引用即拒绝，并指出引用者）
 *
 * 纯函数，不碰磁盘；事务提交时由 Database 调用。
 */

import { isValidId } from "./id.ts";
import type {
	CalendarDoc,
	ModelDoc,
	PlanDoc,
	PricingSchema,
	RuleDoc,
} from "../pricing-types.ts";

/** 删除保护的返回结果 */
export interface CheckResult {
	/** 是否允许删除 */
	ok: boolean;
	/** 拒绝原因（ok=true 时为空串） */
	reason: string;
}

/** 允许删除 */
const ALLOW: CheckResult = { ok: true, reason: "" };

/** 拒绝删除并给出原因 */
function deny(reason: string): CheckResult {
	return { ok: false, reason };
}

// ── 值格式校验 ────────────────────────────────────────────────────────────

/** "HH:MM"（00:00 - 23:59） */
function isValidTime(value: string): boolean {
	const m = /^(\d{2}):(\d{2})$/.exec(value);
	if (!m) return false;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

/** "HH:MM" → 分钟数 */
function toMinutes(value: string): number {
	const [h, m] = value.split(":");
	return Number(h) * 60 + Number(m);
}

/** 单个月份的最大天数（闰年 2 月 29） */
function daysInMonth(year: number, month: number): number {
	return new Date(year, month, 0).getDate();
}

/** 日期字符串："YYYY-MM-DD"（精确）或 "MM-DD"（每年循环），含合法值范围校验 */
export function isValidDateToken(value: string): boolean {
	const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (full) {
		const [year, month, day] = [Number(full[1]), Number(full[2]), Number(full[3])];
		return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
	}
	const yearly = /^(\d{2})-(\d{2})$/.exec(value);
	if (yearly) {
		const [month, day] = [Number(yearly[1]), Number(yearly[2])];
		// 每年循环用平年天数（02-29 由具体年份决定，此处按闰年放行避免误杀）
		return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(2024, month);
	}
	return false;
}

// ── 全量校验 ──────────────────────────────────────────────────────────────

/** 校验 _id 合法且集合内唯一；返回问题列表 */
function checkIds(name: string, docs: readonly { _id: string }[]): string[] {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const doc of docs) {
		if (!isValidId(doc._id)) issues.push(`${name} 存在非法 _id："${doc._id}"`);
		if (seen.has(doc._id)) issues.push(`${name} 存在重复 _id："${doc._id}"`);
		seen.add(doc._id);
	}
	return issues;
}

/** 校验 name 集合内唯一（无 name 的集合跳过）；返回问题列表 */
function checkNames(name: string, docs: readonly { name?: string }[]): string[] {
	const issues: string[] = [];
	const seen = new Set<string>();
	for (const doc of docs) {
		const value = doc.name;
		if (value === undefined) continue;
		if (value.trim() === "") issues.push(`${name} 存在空 name`);
		if (seen.has(value)) issues.push(`${name} 存在重复 name："${value}"`);
		seen.add(value);
	}
	return issues;
}

/** 校验规则：价格/日历引用存在、时区非空、星期与时段合法、日期合法 */
function checkRules(rules: readonly RuleDoc[], schema: PricingSchema): string[] {
	const issues: string[] = [];
	const rateIds = new Set(schema.rates.map((r) => r._id));
	const calendarIds = new Set(schema.calendars.map((c) => c._id));
	for (const rule of rules) {
		if (!rateIds.has(rule.rateId)) issues.push(`规则「${rule.name}」引用了不存在的价格（_id=${rule.rateId}）`);
		for (const cal of [...rule.includeCalendars, ...rule.excludeCalendars]) {
			if (!calendarIds.has(cal)) issues.push(`规则「${rule.name}」引用了不存在的日历（_id=${cal}）`);
		}
		if (rule.timezone.trim() === "") issues.push(`规则「${rule.name}」缺少时区`);
		for (const day of rule.weekdays) {
			if (!Number.isInteger(day) || day < 1 || day > 7) issues.push(`规则「${rule.name}」的星期取值非法：${day}`);
		}
		for (const [start, end] of rule.ranges) {
			if (!isValidTime(start) || !isValidTime(end)) {
				issues.push(`规则「${rule.name}」的时段格式非法：["${start}","${end}"]`);
			} else if (toMinutes(start) >= toMinutes(end)) {
				issues.push(`规则「${rule.name}」的时段起点不小于终点（跨天请拆两段）：["${start}","${end}"]`);
			}
		}
		for (const date of [...rule.includeDates, ...rule.excludeDates]) {
			if (!isValidDateToken(date)) issues.push(`规则「${rule.name}」的日期非法："${date}"`);
		}
		if (rule.validUntil !== undefined && !isValidDateToken(rule.validUntil)) {
			issues.push(`规则「${rule.name}」的截止日期非法："${rule.validUntil}"`);
		}
	}
	return issues;
}

/** 校验方案：引用的规则必须存在（允许空方案：先建方案、再逐步纳入规则） */
function checkPlans(plans: readonly PlanDoc[], schema: PricingSchema): string[] {
	const issues: string[] = [];
	const ruleIds = new Set(schema.rules.map((r) => r._id));
	for (const plan of plans) {
		for (const id of plan.ruleIds) {
			if (!ruleIds.has(id)) issues.push(`方案「${plan.name}」引用了不存在的规则（_id=${id}）`);
		}
	}
	return issues;
}

/** 校验模型：方案存在 + (provider, model) 组合唯一 */
function checkModels(models: readonly ModelDoc[], schema: PricingSchema): string[] {
	const issues: string[] = [];
	const planIds = new Set(schema.plans.map((p) => p._id));
	const seen = new Set<string>();
	for (const model of models) {
		if (!planIds.has(model.planId)) issues.push(`模型 ${model.provider}/${model.model} 引用了不存在的方案（_id=${model.planId}）`);
		const key = `${model.provider}\u0000${model.model}`;
		if (seen.has(key)) issues.push(`模型组合重复：${model.provider}/${model.model}`);
		seen.add(key);
	}
	return issues;
}

/** 校验日历日期格式 */
function checkCalendars(calendars: readonly CalendarDoc[]): string[] {
	const issues: string[] = [];
	for (const cal of calendars) {
		for (const date of cal.dates) {
			if (!isValidDateToken(date)) issues.push(`日历「${cal.name}」的日期非法："${date}"`);
		}
	}
	return issues;
}

/** 全量校验：返回问题列表（空数组 = 通过） */
export function validateSchema(schema: PricingSchema): string[] {
	return [
		...checkIds("rates", schema.rates),
		...checkIds("calendars", schema.calendars),
		...checkIds("rules", schema.rules),
		...checkIds("plans", schema.plans),
		...checkIds("models", schema.models),
		...checkNames("rates", schema.rates),
		...checkNames("calendars", schema.calendars),
		...checkNames("rules", schema.rules),
		...checkNames("plans", schema.plans),
		...checkCalendars(schema.calendars),
		...checkRules(schema.rules, schema),
		...checkPlans(schema.plans, schema),
		...checkModels(schema.models, schema),
	];
}

// ── 删除保护 ──────────────────────────────────────────────────────────────

/** 删除价格：被任一规则引用则拒绝 */
export function checkRateDeletable(schema: PricingSchema, rateId: string): CheckResult {
	const rate = schema.rates.find((r) => r._id === rateId);
	const users = schema.rules.filter((rule) => rule.rateId === rateId);
	if (users.length === 0) return ALLOW;
	const names = users.map((r) => `「${r.name}」`).join("、");
	return deny(`价格「${rate?.name ?? rateId}」仍被规则 ${names} 引用`);
}

/** 删除日历：被任一规则 include/exclude 则拒绝 */
export function checkCalendarDeletable(schema: PricingSchema, calendarId: string): CheckResult {
	const cal = schema.calendars.find((c) => c._id === calendarId);
	const users = schema.rules.filter(
		(rule) => rule.includeCalendars.includes(calendarId) || rule.excludeCalendars.includes(calendarId),
	);
	if (users.length === 0) return ALLOW;
	const names = users.map((r) => `「${r.name}」`).join("、");
	return deny(`日历「${cal?.name ?? calendarId}」仍被规则 ${names} 引用`);
}

/** 删除规则：被任一方案引用则拒绝 */
export function checkRuleDeletable(schema: PricingSchema, ruleId: string): CheckResult {
	const rule = schema.rules.find((r) => r._id === ruleId);
	const users = schema.plans.filter((plan) => plan.ruleIds.includes(ruleId));
	if (users.length === 0) return ALLOW;
	const names = users.map((p) => `「${p.name}」`).join("、");
	return deny(`规则「${rule?.name ?? ruleId}」仍被方案 ${names} 引用`);
}

/** 删除方案：被任一模型绑定则拒绝 */
export function checkPlanDeletable(schema: PricingSchema, planId: string): CheckResult {
	const plan = schema.plans.find((p) => p._id === planId);
	const users = schema.models.filter((m) => m.planId === planId);
	if (users.length === 0) return ALLOW;
	const names = users.map((m) => `${m.provider}/${m.model}`).join("、");
	return deny(`方案「${plan?.name ?? planId}」仍被模型 ${names} 绑定`);
}

/** 删除模型：无引用者，恒允许（保留接口一致性） */
export function checkModelDeletable(_schema: PricingSchema, _modelId: string): CheckResult {
	return ALLOW;
}
