/**
 * 纯函数层：把 v2 数据折叠成抽屉/列表行（ProviderRow / ModelRow）。
 * TUI 无关，node 单测直接断言；表现层与格式化层消费。
 */

import { readPricing } from "./pricing-store.ts";
import { listProviderModels, listProviders } from "./pricing-query.ts";
import { describeSchedule, price } from "./pricing-desc.ts";
import type { PricingRule, Schedule } from "./pricing-types.ts";

/** 抽屉第 0 级（厂商列表）的一行数据 */
export interface ProviderRow {
	providerId: string;
	modelCount: number;
	/** 厂商绑定的方案名摘要（如 "工作日高峰 · 全时谷价"） */
	planDesc: string;
	description: string;
}

/** 抽屉第 1 级（模型列表）的一行数据 */
export interface ModelRow {
	modelId: string;
	alias?: string;
	/** 实时生效输出价（"¥4.00"） */
	liveOutput: string;
	/** 实时生效输入价（"未缓存 ¥1.00 / 缓存 ¥0.02"） */
	liveInputText: string;
	/** 实时时段状态（"普通时段" / "高峰时段"） */
	timeState: string;
	/** 绑定方案数 / 启用数 */
	boundCount: number;
	enabledCount: number;
	/** 每条启用规则的价目行（谷/峰排列） */
	priceLines: string[];
	description: string;
}

/** 规则是否"永远匹配"（weekdays/ranges 空 且无日历/日期覆盖） */
export function isAlwaysRule(rule: PricingRule): boolean {
	const s = rule.schedule;
	return s.weekdays.length === 0 && s.ranges.length === 0 &&
		!s.calendar && !s.includeDates && !s.excludeDates;
}

/** 格式化一条规则的中文摘要（"工作日 09:00-12:00 / 14:00-18:00"、"全天"） */
export function describeRule(rule: PricingRule): string {
	return describeSchedule(rule.schedule);
}

/** 列出抽屉第 0 级所需的所有厂商行 */
export function listProviderRows(filePath?: string): ProviderRow[] {
	const providers = listProviders(filePath);
	const schema = readPricing(filePath);

	const rows: ProviderRow[] = [];
	for (const providerId of providers) {
		const prov = schema.providers[providerId];
		const modelCount = Object.keys(prov?.models ?? {}).length;
		// 收集该厂商所有模型绑定的方案（去重，保持出现顺序）
		const planIds: string[] = [];
		for (const conf of Object.values(prov?.models ?? {})) {
			for (const b of conf.plans) {
				if (!planIds.includes(b.plan)) planIds.push(b.plan);
			}
		}
		const planNames = planIds.map((id) => schema.plans[id]?.name ?? id).join(" · ");
		// 各方案规则的中文摘要（去重）
		const descs: string[] = [];
		for (const id of planIds) {
			const plan = schema.plans[id];
			for (const rule of plan?.rules ?? []) {
				const d = describeRule(rule);
				if (!descs.includes(d)) descs.push(d);
			}
		}
		rows.push({
			providerId,
			modelCount,
			planDesc: planNames,
			description: `${providerId}：${modelCount} 个模型 · 方案 ${planNames || "（无）"} · ${descs.join(" / ") || "无峰时段"}`,
		});
	}
	return rows;
}

/** 列出抽屉第 1 级（指定厂商下）所需的所有模型行 */
export function listModelRows(provider: string, filePath?: string): ModelRow[] {
	const infos = listProviderModels(provider, undefined, filePath);
	return infos.map((info) => {
		const enabled = info.planBindings.filter((b) => b.enabled);
		const live = info.livePrice;
		const priceLines: string[] = [];
		for (const planName of enabled.map((b) => b.planName)) priceLines.push(`  当前生效 ${planName}`);
		return {
			modelId: info.model,
			alias: info.alias,
			liveOutput: price(live.output),
			liveInputText: `未缓存 ${price(live.inputMiss)} / 缓存 ${price(live.inputHit)}`,
			timeState: live.isPeak ? "高峰时段" : "普通时段",
			boundCount: info.planBindings.length,
			enabledCount: enabled.length,
			priceLines,
			description: `${info.model}${info.alias ? `（别名 ${info.alias}）` : ""}：绑定 ${info.planBindings.map((b) => `${b.planName}${b.enabled ? "" : "〔禁用〕"}`).join("、")} · 当前 ${price(live.output)}${live.isPeak ? "（高峰时段）" : ""}`,
		};
	});
}

export { describeSchedule };
export type { Schedule };