/**
 * /price 命令实现：list / set / schema / reload。
 *
 * 接线层：连接 pi.registerCommand → pricing-store + pricing-query + pricing-format。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPricing, readPricing, updatePricing } from "./pricing-store.ts";
import { renderPriceList, renderModelDetail, renderSchema } from "./pricing-format.ts";
import type { ModelPricing, PricingSchema } from "./pricing-types.ts";

/** 格式化价格值：支持 "4"、"4.5"、"¥4" 等输入 → 解析为 number */
function parsePriceValue(raw: string): number | null {
	const cleaned = raw.replace(/^¥/, "").trim();
	const num = Number(cleaned);
	if (!Number.isFinite(num) || num < 0) return null;
	return num;
}

/** 解析 field 路径：如 "output.standard" → ["output", "standard"]；无效返回 null */
function parseFieldPath(field: string): ["input" | "output", string] | null {
	const validPaths: Record<string, ["input" | "output", string]> = {
		"input.miss": ["input", "miss"],
		"input.hit": ["input", "hit"],
		"output.standard": ["output", "standard"],
		"output.peak": ["output", "peak"],
	};
	return validPaths[field] ?? null;
}

/** 设置 ModelPricing 的嵌套字段值 */
function setModelField(mp: ModelPricing, group: "input" | "output", key: string, value: number): void {
	switch (`${group}.${key}`) {
		case "input.miss": mp.input.miss = value; break;
		case "input.hit": mp.input.hit = value; break;
		case "output.standard": mp.output.standard = value; break;
		case "output.peak": mp.output.peak = value; break;
	}
}

export class PricingCommands {
	mount(pi: ExtensionAPI): void {
		seedPricing();

		pi.registerCommand("price", {
			description: "模型计费配置：查看与编辑 /price list|set|schema|reload",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const parts = args.trim().split(/\s+/);
				const sub = parts[0] ?? "list";

				switch (sub) {
					case "list":
						ctx.ui.notify(renderPriceList(), "info");
						break;
					case "show":
						if (!parts[1] || !parts[2]) {
							ctx.ui.notify("用法: /price show <provider> <model>", "info");
							break;
						}
						ctx.ui.notify(renderModelDetail(parts[1], parts[2]), "info");
						break;
					case "set":
						this.setModel(parts[1], parts[2], parts[3], parts[4], ctx);
						break;
					case "schema":
						ctx.ui.notify(renderSchema(), "info");
						break;
					case "reload":
						this.reload(ctx);
						break;
					default:
						ctx.ui.notify("用法: /price [list|show|set|schema|reload]", "info");
				}
			},
		});
	}

	private setModel(
		provider: string | undefined,
		model: string | undefined,
		field: string | undefined,
		value: string | undefined,
		ctx: ExtensionCommandContext,
	): void {
		if (!provider || !model || !field || !value) {
			ctx.ui.notify("用法: /price set <provider> <model> <field> <value>\n  field: input.miss / input.hit / output.standard / output.peak\n  例: /price set deepseek deepseek-flash output.standard 4.5", "info");
			return;
		}

		const fieldPath = parseFieldPath(field);
		if (!fieldPath) {
			ctx.ui.notify(`无效字段: ${field}\n可用字段: input.miss / input.hit / output.standard / output.peak`, "info");
			return;
		}

		const priceValue = parsePriceValue(value);
		if (priceValue === null) {
			ctx.ui.notify(`无效价格: ${value}\n请输入非负数字（如 4、4.5、¥0.02）`, "info");
			return;
		}

		const [group, key] = fieldPath;
		let updated: PricingSchema;
		try {
			updated = updatePricing((data) => {
				const prov = data.providers[provider!];
				if (!prov) throw new Error(`未知厂商: ${provider}`);
				if (!(model! in prov.models)) throw new Error(`${provider} 下未找到模型: ${model}`);
				setModelField(prov.models[model!], group, key, priceValue);
				return data;
			});
		} catch (err) {
			ctx.ui.notify(`修改失败: ${(err as Error).message}`, "info");
			return;
		}

		const mp = updated.providers[provider]?.models[model!];
		let actualVal: number | null = null;
		if (mp) {
			if (group === "input") actualVal = mp.input[key as "miss" | "hit"];
			else actualVal = mp.output[key as "standard" | "peak"];
		}
		ctx.ui.notify(`已修改: ${provider}/${model} ${field} = ${actualVal}\n/price reload 重载生效`, "info");
	}

	private reload(ctx: ExtensionCommandContext): void {
		const data = readPricing();
		const modelCount = Object.values(data.providers).reduce(
			(sum, p) => sum + Object.keys(p.models).length,
			0,
		);
		const provCount = Object.keys(data.providers).length;
		ctx.ui.notify(`已重载: ${provCount} 厂商 · ${modelCount} 模型 · schema v${data.version}\n/price list 查看`, "info");
	}
}
