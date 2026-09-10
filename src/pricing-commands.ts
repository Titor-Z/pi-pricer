/**
 * /price 命令实现：v2 五注册表浏览 + 绑定管理 + 调试。
 *
 * 接线层：pi.registerCommand → pricing-ui（抽屉）+ pricing-store +
 * pricing-query + pricing-format。编辑主链路在 TUI 抽屉（M2/M3），
 * CLI 保留查询/绑定/兜底操作。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPricing, updatePricing, checkPlanDeletable, checkPriceDeletable } from "./pricing-store.ts";
import { listProviders } from "./pricing-query.ts";
import {
	renderPriceList,
	renderModelDetail,
	renderSchema,
	renderPlanList,
	renderPlanDetail,
	renderPriceRegistry,
	renderCalendarList,
	renderResolveResult,
	renderHelp,
} from "./pricing-format.ts";
import { PricingDrawer } from "./pricing-ui.ts";

/** 格式化价格值：支持 "4"、"4.5"、"¥4" 等输入 → 解析为 number */
function parsePriceValue(raw: string): number | null {
	const cleaned = raw.replace(/^¥/, "").trim();
	const num = Number(cleaned);
	if (!Number.isFinite(num) || num < 0) return null;
	return num;
}

/** 解析价格字段路径：input.miss / input.hit / output */
function parsePriceField(field: string): "input.miss" | "input.hit" | "output" | null {
	if (field === "input.miss" || field === "input.hit" || field === "output") return field;
	return null;
}

/** 修改价格实体字段值 */
function setPriceField(p: { input: { miss: number; hit: number }; output: number }, field: "input.miss" | "input.hit" | "output", value: number): void {
	switch (field) {
		case "input.miss": p.input.miss = value; break;
		case "input.hit": p.input.hit = value; break;
		case "output": p.output = value; break;
	}
}

export class PricingCommands {
	private readonly drawer: PricingDrawer;

	/** filePath 注入便于单测隔离（默认读 ~/.pi/model-pricing.json） */
	private readonly filePath?: string;

	constructor(filePath?: string) {
		this.filePath = filePath;
		this.drawer = new PricingDrawer(filePath);
	}

	mount(pi: ExtensionAPI): void {
		seedPricing(this.filePath);

		pi.registerCommand("price", {
			description: "模型计费（v2 五注册表）：无参开抽屉 | model|plan|price|calendar|resolve|bind|unbind|schema|list|help",
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				const parts = args.trim().split(/\s+/);
				const sub = parts[0] ?? "";

				switch (sub) {
					case "":
						// 无参：TUI 下开抽屉（模型面）；headless 回退文本总览
						if (await this.drawer.open(ctx)) break;
						ctx.ui.notify(renderPriceList(this.filePath), "info");
						break;
					case "list":
						ctx.ui.notify(renderPriceList(this.filePath), "info");
						break;
					case "help":
						ctx.ui.notify(renderHelp(), "info");
						break;
					case "model":
						this.showModel(parts[1], parts[2], ctx);
						break;
					case "plan":
						this.showPlan(parts[1], ctx);
						break;
					case "price":
						this.priceOp(parts[1], parts[2], parts[3], parts[4], ctx);
						break;
					case "calendar":
						ctx.ui.notify(renderCalendarList(this.filePath), "info");
						break;
					case "resolve":
						this.resolve(parts[1], parts[2], parts[3], ctx);
						break;
					case "bind":
						this.bindModel(parts[1], parts[2], parts[3], ctx);
						break;
					case "unbind":
						this.unbindModel(parts[1], parts[2], parts[3], ctx);
						break;
					case "schema":
						ctx.ui.notify(renderSchema(), "info");
						break;
					default:
						ctx.ui.notify(renderHelp(), "info");
				}
			},
		});
	}

	private showModel(provider: string | undefined, model: string | undefined, ctx: ExtensionCommandContext): void {
		if (!provider || !model) {
			ctx.ui.notify("用法: /price model <provider> <model>", "info");
			return;
		}
		ctx.ui.notify(renderModelDetail(provider, model, this.filePath), "info");
	}

	private showPlan(planId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!planId) {
			ctx.ui.notify(renderPlanList(this.filePath), "info");
			return;
		}
		ctx.ui.notify(renderPlanDetail(planId, this.filePath), "info");
	}

	private priceOp(op: string | undefined, id: string | undefined, field: string | undefined, value: string | undefined, ctx: ExtensionCommandContext): void {
		switch (op) {
			case "set":
				this.setPrice(id, field, value, ctx);
				break;
			case "delete":
				this.deletePrice(id, ctx);
				break;
			default:
				ctx.ui.notify(renderPriceRegistry(this.filePath), "info");
				break;
		}
	}

	private setPrice(priceId: string | undefined, field: string | undefined, value: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId || !field || !value) {
			ctx.ui.notify("用法: /price price set <price-id> <input.miss|input.hit|output> <value>\n  例: /price price set deepseek-peak input.miss 2", "info");
			return;
		}
		const f = parsePriceField(field);
		if (!f) {
			ctx.ui.notify(`无效字段: ${field}（可用 input.miss / input.hit / output）`, "info");
			return;
		}
		const v = parsePriceValue(value);
		if (v === null) {
			ctx.ui.notify(`无效价格: ${value}（非负数字，如 4、4.5、¥0.02）`, "info");
			return;
		}
		try {
			updatePricing((data) => {
				const p = data.prices[priceId!];
				if (!p) throw new Error(`未找到价格实体: ${priceId}`);
				setPriceField(p, f, v);
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`修改失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已修改价格 ${priceId} ${f} = ${v}（/price price 查看）`, "info");
	}

	private deletePrice(priceId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId) {
			ctx.ui.notify("用法: /price price delete <price-id>", "info");
			return;
		}
		try {
			updatePricing((data) => {
				const guard = checkPriceDeletable(data, priceId!);
				if (!guard.ok) throw new Error(guard.reason);
				delete data.prices[priceId!];
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`删除失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已删除价格实体 ${priceId}`, "info");
	}

	private resolve(model: string | undefined, provider: string | undefined, ts: string | undefined, ctx: ExtensionCommandContext): void {
		if (!model) {
			ctx.ui.notify("用法: /price resolve <model> [provider] [YYYY-MM-DDTHH:mm]\n  例: /price resolve deepseek-flash deepseek 2026-09-16T10:00", "info");
			return;
		}
		const providers = listProviders(this.filePath);
		const prov = provider ?? providers[0] ?? "deepseek";
		let date: Date | undefined;
		if (ts) {
			date = new Date(ts.includes("T") ? ts : `${ts}T12:00:00`);
			if (Number.isNaN(date.getTime())) date = undefined;
		}
		ctx.ui.notify(renderResolveResult(model, prov, date, this.filePath), "info");
	}

	private bindModel(provider: string | undefined, model: string | undefined, plan: string | undefined, ctx: ExtensionCommandContext): void {
		if (!provider || !model || !plan) {
			ctx.ui.notify("用法: /price bind <provider> <model> <plan-id>", "info");
			return;
		}
		try {
			updatePricing((data) => {
				const conf = data.providers[provider!]?.models[model!];
				if (!conf) throw new Error(`未找到模型: ${provider}/${model}`);
				if (!data.plans[plan!]) throw new Error(`未找到方案: ${plan}`);
				const existing = conf.plans.find((b) => b.plan === plan!);
				if (existing) existing.enabled = true;
				else conf.plans.push({ plan: plan!, enabled: true });
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`绑定失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已绑定 ${provider}/${model} → ${plan}（排最后=最低优先级；/price model 查看）`, "info");
	}

	private unbindModel(provider: string | undefined, model: string | undefined, plan: string | undefined, ctx: ExtensionCommandContext): void {
		if (!provider || !model || !plan) {
			ctx.ui.notify("用法: /price unbind <provider> <model> <plan-id>", "info");
			return;
		}
		try {
			updatePricing((data) => {
				const conf = data.providers[provider!]?.models[model!];
				if (!conf) throw new Error(`未找到模型: ${provider}/${model}`);
				const before = conf.plans.length;
				conf.plans = conf.plans.filter((b) => b.plan !== plan!);
				if (conf.plans.length === before) throw new Error(`该模型未绑定方案: ${plan}`);
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`解除失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已解除 ${provider}/${model} → ${plan}`, "info");
	}
}