/**
 * 纯函数层：把 JSON 价格数据折叠成抽屉行（ProviderRow / ModelRow）。
 *
 * TUI 无关，node 单测直接断言；表现层（PricingDrawer）消费这些行构建
 * SettingsList 的 SettingItem，接线层只负责"命令 → 打开抽屉"。
 */

import { readPricing } from "./pricing-store.ts";
import { listProviders } from "./pricing-query.ts";
import type { PeakHours } from "./pricing-types.ts";

/** 抽屉第 0 级（厂商列表）的一行数据 */
export interface ProviderRow {
	providerId: string;
	modelCount: number;
	peakDesc: string;
	description: string;
}

/** 抽屉第 1 级（模型列表）的一行数据 */
export interface ModelRow {
	modelId: string;
	alias?: string;
	outputText: string;
	inputText: string;
	description: string;
}

/** 格式化单个价格（¥1 → "¥1.00"；¥0.02 → "¥0.02"） */
function price(n: number): string {
	return `¥${n.toFixed(2)}`;
}

/** 峰时段描述（如 "峰 一二三四五 9-12 / 14-18"；无峰 → "无峰时段"） */
function formatPeakDesc(peakHours: PeakHours | null): string {
	if (!peakHours) return "无峰时段";
	const days = peakHours.weekdays.map((d) => ["一", "二", "三", "四", "五", "六", "日"][d - 1]).join("");
	const ranges = peakHours.ranges.map(([s, e]) => `${s}-${e}`).join(" / ");
	return `峰 ${days} ${ranges}`;
}

/** 列出抽屉第 0 级所需的所有厂商行 */
export function listProviderRows(filePath?: string): ProviderRow[] {
	const providers = listProviders(filePath);
	const schema = readPricing(filePath);

	const rows: ProviderRow[] = [];
	for (const providerId of providers) {
		const prov = schema.providers[providerId];
		const modelCount = Object.keys(prov?.models ?? {}).length;
		const peakDesc = formatPeakDesc(prov?.peakHours ?? null);
		const rangesDesc = prov?.peakHours
			? `工作日 ${prov.peakHours.weekdays.map((d) => ["一", "二", "三", "四", "五", "六", "日"][d - 1]).join("/")} ${prov.peakHours.ranges.map(([s, e]) => `${s}:00-${e}:00`).join(" / ")}（${prov.peakHours.timezone}）`
			: "全天统一价";
		rows.push({
			providerId,
			modelCount,
			peakDesc,
			description: `${providerId}：${modelCount} 个模型 · ${rangesDesc} · 输入输出均按 JSON 价表计费`,
		});
	}
	return rows;
}

/** 列出抽屉第 1 级（指定厂商下）所需的所有模型行 */
export function listModelRows(provider: string, filePath?: string): ModelRow[] {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return [];

	const hasPeak = prov.peakHours !== null;
	const rows: ModelRow[] = [];
	const modelIds = Object.keys(prov.models);
	for (const modelId of modelIds) {
		const mp = prov.models[modelId];
		rows.push({
			modelId,
			alias: mp.alias,
			outputText: hasPeak && mp.output.peak !== null
				? `${price(mp.output.standard)}→${price(mp.output.peak)}`
				: price(mp.output.standard),
			inputText: `${price(mp.input.miss)} / ${price(mp.input.hit)}`,
			description: `${modelId}${mp.alias ? `（别名 ${mp.alias}）` : ""}：输出 ${mp.output.peak !== null ? `标准 ${price(mp.output.standard)} · 峰 ${price(mp.output.peak)}` : price(mp.output.standard)}/M token · 输入 miss ${price(mp.input.miss)} · hit ${price(mp.input.hit)} · /price set ${provider} ${modelId} <field> <value> 编辑`,
		});
	}
	return rows;
}