/**
 * 格式化渲染：将价格数据格式化为终端可读文本。
 *
 * 输出风格对齐 pi-prompt 的 /prompt usage：灰白阶 + 等宽对齐。
 */

import type { PricingSchema, ProviderPricing } from "./pricing-types.ts";
import { listProviderModels, listProviders } from "./pricing-query.ts";
import { readPricing } from "./pricing-store.ts";

/** 格式化单个价格（¥1 → "¥1.00"；¥0.02 → "¥0.02"） */
function price(n: number): string {
	return `¥${n.toFixed(2)}`;
}

/** 渲染 /price list 的完整表格（所有厂商） */
export function renderPriceList(filePath?: string): string {
	const providers = listProviders(filePath);
	if (providers.length === 0) return "暂无模型计费数据。";

	const lines: string[] = [];
	for (const prov of providers) {
		lines.push(renderProviderHeader(prov, filePath));
		const models = listProviderModels(prov, undefined, filePath);
		for (const m of models) {
			lines.push(renderModelRow(m, filePath));
		}
	}

	lines.push("");
	lines.push(`文件: ~/.pi/model-pricing.json · /price set <provider> <model> <field> <value>`);
	return lines.join("\n");
}

/** 渲染厂商头部行 */
function renderProviderHeader(provider: string, filePath?: string): string {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return provider;

	const modelCount = Object.keys(prov.models).length;
	const peakDesc = formatPeakHours(prov);
	return `\n${provider}  (${modelCount}模型 · ${peakDesc})`;
}

/** 格式化峰时段描述 */
function formatPeakHours(prov: ProviderPricing): string {
	if (!prov.peakHours) return "无峰时段";
	const days = prov.peakHours.weekdays.map((d) => ["一", "二", "三", "四", "五", "六", "日"][d - 1]).join("/");
	const ranges = prov.peakHours.ranges.map(([s, e]) => `${s}-${e}`).join(" / ");
	return `峰 ${days} ${ranges}`;
}

/** 渲染单个模型行 */
function renderModelRow(
	m: { model: string; alias?: string; inputMiss: number; inputHit: number; outputStandard: number; outputPeak: number | null; isPeak: boolean },
	filePath?: string,
): string {
	const aliasStr = m.alias ? ` (aka ${m.alias})` : "";
	const outStr = m.outputPeak !== null
		? `${price(m.outputStandard)}→${price(m.outputPeak)}`
		: price(m.outputStandard);
	return `  ${m.model}${aliasStr}  out ${outStr} · miss ${price(m.inputMiss)} hit ${price(m.inputHit)}`;
}

/** 渲染 /price show <provider> <model> 的详情页 */
export function renderModelDetail(
	provider: string,
	model: string,
	filePath?: string,
): string {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return `未知厂商: ${provider}`;
	if (!(model in prov.models)) return `${provider} 下未找到模型: ${model}`;

	const mp = prov.models[model];
	const lines: string[] = [];
	lines.push(`\n${provider}/${model}`);
	if (mp.alias) lines.push(`  别名: ${mp.alias}`);
	lines.push(`  输入: miss ${price(mp.input.miss)}/M · hit ${price(mp.input.hit)}/M`);
	const outPeak = mp.output.peak !== null ? ` · 峰 ${price(mp.output.peak)}/M` : "";
	lines.push(`  输出: ${price(mp.output.standard)}/M${outPeak}`);
	lines.push(`  峰时段: ${formatPeakHours(prov)} (${prov.peakHours?.timezone ?? "N/A"})`);
	lines.push("");
	lines.push(`  编辑: /price set ${provider} ${model} output.standard <新价格>`);
	return lines.join("\n");
}

/** 渲染 /price schema 的说明文本 */
export function renderSchema(): string {
	return [
		"",
		"~/.pi/model-pricing.json Schema v1",
		"",
		"结构:",
		"  providers: {",
		'    "<provider-id>": {',
		"      peakHours: { timezone, weekdays: [1-7], ranges: [[start,end)] } | null,",
		"      models: {",
		'        "<model-id>": {',
		'          alias: "<pi-内部名>",',
		"          input: { miss: ¥/M, hit: ¥/M },",
		"          output: { standard: ¥/M, peak: ¥/M | null }",
		"        }",
		"      }",
		"    }",
		"  }",
		"",
		"字段说明:",
		"  peakHours.weekdays  星期几（1=周一 ... 7=周日）",
		"  peakHours.ranges    小时段 [start, end) 半开区间",
		"  alias               pi 内部 model 名的别名（台账匹配用）",
		"  input.miss          缓存未命中输入价（¥/百万 token）",
		"  input.hit           缓存命中输入价（¥/百万 token）",
		"  output.standard     空闲输出价（¥/百万 token）",
		"  output.peak         峰值输出价（null = 无峰谷）",
		"",
		"编辑后 /price reload 重载。",
	].join("\n");
}
