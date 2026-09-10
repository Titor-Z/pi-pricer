/**
 * /price 命令实现：v2 五注册表浏览 + 绑定管理 + 调试。
 *
 * 接线层：pi.registerCommand → pricing-ui（抽屉）+ pricing-store +
 * pricing-query + pricing-format。编辑主链路在 TUI 抽屉（M2/M3），
 * CLI 保留查询/绑定/兜底操作。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPricing, updatePricing, readPricing, checkPlanDeletable, checkPriceDeletable } from "./pricing-store.ts";
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
						this.planOp(parts[1], parts[2], parts[3], ctx);
						break;
					case "price":
						this.priceOp(parts[1], parts[2], parts[3], parts[4], ctx);
						break;
					case "calendar":
						this.calendarOp(parts[1], parts[2], parts[3], parts.slice(4), ctx);
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
					case "move":
						this.moveBinding(parts[1], parts[2], parts[3], parts[4], ctx);
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

	/** /price plan [<id>] | plan create <id> <name> | plan duplicate <id> | plan delete <id> */
	private planOp(op: string | undefined, id: string | undefined, name: string | undefined, ctx: ExtensionCommandContext): void {
		switch (op) {
			case "create":
				this.createPlan(id, name, ctx);
				break;
			case "duplicate":
				this.duplicatePlan(id, ctx);
				break;
			case "delete":
				this.deletePlan(id, ctx);
				break;
			case undefined:
				ctx.ui.notify(renderPlanList(this.filePath), "info");
				break;
			default:
				ctx.ui.notify(renderPlanDetail(op, this.filePath), "info");
		}
	}

	/** 新建方案：空方案无规则会导致校验失败，故默认挂上第一个价格实体作为 always 规则 */
	private createPlan(planId: string | undefined, name: string | undefined, ctx: ExtensionCommandContext): void {
		if (!planId) {
			ctx.ui.notify("用法: /price plan create <plan-id> [name]", "info");
			return;
		}
		try {
			let created = false;
			updatePricing((data) => {
				if (data.plans[planId]) throw new Error(`方案已存在: ${planId}`);
				const firstPrice = Object.keys(data.prices)[0];
				if (!firstPrice) throw new Error("价格注册表为空，请先 /price price create");
				data.plans[planId] = {
					name: name ?? planId,
					rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: firstPrice }],
				};
				created = true;
				return data;
			}, this.filePath);
			if (created) ctx.ui.notify(`已新建方案 ${planId}（默认挂价格 ${Object.keys(readPricing(this.filePath).prices)[0]}，请 /price bind 绑定）`, "info");
		} catch (err) {
			ctx.ui.notify(`新建失败: ${(err as Error).message}`, "info");
		}
	}

	/** 复制方案：新 id 自动去重（<id>-copy / <id>-copy2 ...） */
	private duplicatePlan(planId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!planId) {
			ctx.ui.notify("用法: /price plan duplicate <plan-id>", "info");
			return;
		}
		let newId = "";
		try {
			updatePricing((data) => {
				const src = data.plans[planId!];
				if (!src) throw new Error(`未找到方案: ${planId}`);
				newId = `${planId}-copy`;
				let n = 2;
				while (data.plans[newId]) {
					newId = `${planId}-copy${n}`;
					n += 1;
				}
				data.plans[newId] = { name: `${src.name}（副本）`, rules: JSON.parse(JSON.stringify(src.rules)) };
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`复制失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已复制为 ${newId}`, "info");
	}

	/** 删除方案（引用于被绑定时拒绝） */
	private deletePlan(planId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!planId) {
			ctx.ui.notify("用法: /price plan delete <plan-id>", "info");
			return;
		}
		try {
			updatePricing((data) => {
				const guard = checkPlanDeletable(data, planId!);
				if (!guard.ok) throw new Error(guard.reason);
				delete data.plans[planId!];
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`删除失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已删除方案 ${planId}`, "info");
	}

	/** /price calendar [add <id> <name> <dates...>] [remove <id>] */
	private calendarOp(op: string | undefined, id: string | undefined, name: string | undefined, dates: string[], ctx: ExtensionCommandContext): void {
		switch (op) {
			case "add":
				this.addCalendar(id, name, dates, ctx);
				break;
			case "remove":
				this.removeCalendar(id, ctx);
				break;
			case undefined:
				ctx.ui.notify(renderCalendarList(this.filePath), "info");
				break;
			default:
				ctx.ui.notify(`未知子命令: ${op}\n用法: /price calendar [add <id> <name> <dates> | remove <id>]`, "info");
		}
	}

	/** 新建/覆盖日历；日期支持 "YYYY-MM-DD"（单年）与 "MM-DD"（每年循环） */
	private addCalendar(calId: string | undefined, name: string | undefined, dates: string[], ctx: ExtensionCommandContext): void {
		if (!calId || !name || dates.length === 0) {
			ctx.ui.notify("用法: /price calendar add <id> <name> <dates...>\n  例: /price calendar add cn-holiday 法定节假日 01-01 10-01", "info");
			return;
		}
		const bad = dates.find((d) => !/^(\d{4}-)?\d{2}-\d{2}$/.test(d));
		if (bad) {
			ctx.ui.notify(`无效日期: ${bad}（格式 YYYY-MM-DD 或 MM-DD）`, "info");
			return;
		}
		try {
			updatePricing((data) => {
				data.calendars[calId!] = { name: name!, dates };
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`创建失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已写入日历 ${calId}（${dates.length} 天）`, "info");
	}

	/** 删除日历（被规则引用时拒绝） */
	private removeCalendar(calId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!calId) {
			ctx.ui.notify("用法: /price calendar remove <id>", "info");
			return;
		}
		try {
			updatePricing((data) => {
				if (!data.calendars[calId]) throw new Error(`未找到日历: ${calId}`);
				for (const [planId, plan] of Object.entries(data.plans)) {
					if (plan.rules.some((r) => r.schedule.calendar === calId)) throw new Error(`日历 "${calId}" 仍被方案 "${planId}" 引用`);
				}
				delete data.calendars[calId!];
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`删除失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已删除日历 ${calId}`, "info");
	}

	/**
	 * /price move <provider> <model> <plan-id> <up|down|top|bottom>
	 * 绑定数组顺序 = 优先级（first match wins）；TUI 不做重排序（SettingsList 无选中索引），
	 * 因此排序能力由 CLI 承担。越界时为空操作并提示，不产生破坏性变更。
	 */
	private moveBinding(provider: string | undefined, model: string | undefined, plan: string | undefined, direction: string | undefined, ctx: ExtensionCommandContext): void {
		if (!provider || !model || !plan || !direction) {
			ctx.ui.notify("用法: /price move <provider> <model> <plan-id> <up|down|top|bottom>", "info");
			return;
		}
		const dir = direction;
		if (!["up", "down", "top", "bottom"].includes(dir)) {
			ctx.ui.notify(`无效方向: ${direction}（可用 up / down / top / bottom）`, "info");
			return;
		}
		let note = "";
		try {
			updatePricing((data) => {
				const conf = data.providers[provider!]?.models[model!];
				if (!conf) throw new Error(`未找到模型: ${provider}/${model}`);
				const i = conf.plans.findIndex((b) => b.plan === plan);
				if (i < 0) throw new Error(`该模型未绑定方案: ${plan}`);
				// 目标下标；越界则夹紧到边界（等价于无操作，但在两端给提示）
				const target = this.resolveMoveTarget(i, conf.plans.length, dir);
				if (target === i) {
					note = `（已在${i === 0 ? "最高" : "最低"}优先级，未移动）`;
					return data;
				}
				const [moved] = conf.plans.splice(i, 1);
				conf.plans.splice(target, 0, moved);
				note = "";
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`移动失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已移动 ${provider}/${model} 的绑定 ${plan} ${dir}${note}（/price model ${provider} ${model} 查看新顺序）`, "info");
	}

	/** 计算移动后的目标下标（up/down 逐位，top/bottom 到端点） */
	private resolveMoveTarget(index: number, length: number, direction: string): number {
		switch (direction) {
			case "up": return Math.max(0, index - 1);
			case "down": return Math.min(length - 1, index + 1);
			case "top": return 0;
			default: return length - 1;
		}
	}

	private priceOp(op: string | undefined, id: string | undefined, field: string | undefined, value: string | undefined, ctx: ExtensionCommandContext): void {
		switch (op) {
			case "set":
				this.setPrice(id, field, value, ctx);
				break;
			case "create":
				this.createPrice(id, field, ctx);
				break;
			case "delete":
				this.deletePrice(id, ctx);
				break;
			default:
				ctx.ui.notify(renderPriceRegistry(this.filePath), "info");
				break;
		}
	}

	/** 新建价格实体：/price price create <id> <name>（初始价 0，用 price set 补） */
	private createPrice(priceId: string | undefined, name: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId) {
			ctx.ui.notify("用法: /price price create <price-id> [name]\n  建后可用 /price price set 修改数值", "info");
			return;
		}
		try {
			updatePricing((data) => {
				if (data.prices[priceId!]) throw new Error(`价格实体已存在: ${priceId}`);
				data.prices[priceId!] = { name: name ?? priceId!, input: { miss: 0, hit: 0 }, output: 0 };
				return data;
			}, this.filePath);
		} catch (err) {
			ctx.ui.notify(`创建失败: ${(err as Error).message}`, "info");
			return;
		}
		ctx.ui.notify(`已新建价格 ${priceId}（初值 0，可 /price price set ${priceId} output <value>）`, "info");
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