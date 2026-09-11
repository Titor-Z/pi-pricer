/**
 * /price 命令实现：v2 五注册表浏览 + 管理面 CRUD。
 *
 * 接线层：pi.registerCommand → pricing-ui（抽屉）+ pricing-store +
 * pricing-query + pricing-format。编辑主链路在 TUI 抽屉（draft + Ctrl+S 保存），
 * CLI 提供等价能力（headless 可完整操作）：查询/管理面 CRUD。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { seedPricing, updatePricing, readPricing, checkPlanDeletable, checkPriceDeletable } from "./pricing-store.ts";
import {
	renderPriceList,
	renderModelDetail,
	renderPlanList,
	renderPlanDetail,
	renderPriceRegistry,
	renderCalendarList,
	renderHelp,
} from "./pricing-format.ts";
import { PricingDrawer, isValidCalendarDate } from "./pricing-ui.ts";
import { PRICE_SUBCOMMANDS, findSubcommand, PRICE_FIELDS } from "./pricing-cli-spec.ts";
import { PricingAgentTools, PRICING_AGENT_TOOL_NAMES } from "./pricing-agent-tool.ts";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { PricingSchema } from "./pricing-types.ts";

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

	/** AI 辅助配置工具集（注册但不激活，/price ai 才启用） */
	private readonly agentTools: PricingAgentTools;

	/** filePath 注入便于单测隔离（默认读 ~/.pi/model-pricing.json） */
	private readonly filePath?: string;

	constructor(filePath?: string) {
		this.filePath = filePath;
		this.drawer = new PricingDrawer(filePath);
		this.agentTools = new PricingAgentTools(filePath);
	}

	mount(pi: ExtensionAPI): void {
		seedPricing(this.filePath);

		// 工具先注册（此时未激活，模型看不到也调不到；/price ai 才加入 active tools）
		this.agentTools.register(pi);

		pi.registerCommand("price", {
			description: "模型计费（v2 五注册表）：无参开抽屉 | model|list|scheme|rate|calendar|ai|help",
			// pi 只认这个字段生成扩展命令的参数补全（扩展无法设 argumentHint）
			getArgumentCompletions: (prefix: string) => this.completeArguments(prefix),
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
						// TUI 下以 Markdown 总览只读页呈现；headless 回退纯文本
						if (await this.drawer.open(ctx, "list")) break;
						ctx.ui.notify(renderPriceList(this.filePath), "info");
						break;
					case "help":
						// TUI 下打开帮助页（InfoPage 排版，可滚动）；headless 回退纯文本
						if (await this.drawer.open(ctx, "help")) break;
						ctx.ui.notify(renderHelp(), "info");
						break;
					case "model":
						await this.showModel(parts[1], parts[2], ctx);
						break;
					case "scheme":
						// TUI 下直达方案管理页；headless 回退文本
						if (await this.drawer.open(ctx, "scheme")) break;
						this.planOp(parts[1], parts[2], parts[3], ctx);
						break;
					case "rate":
						// TUI 下直达价格管理页；headless 回退文本
						if (await this.drawer.open(ctx, "rate")) break;
						this.priceOp(parts[1], parts[2], parts[3], parts[4], ctx);
						break;
					case "calendar":
						// TUI 下直达日历管理页；headless 回退文本
						if (await this.drawer.open(ctx, "calendar")) break;
						this.calendarOp(parts[1], parts[2], parts[3], parts.slice(4), ctx);
						break;
					case "ai":
						await this.aiOp(parts[1], pi, ctx);
						break;
					default:
						ctx.ui.notify(renderHelp(), "info");
				}
			},
		});
	}

	/**
	 * /price 的参数补全（pi 的 getArgumentCompletions 协议）。
	 *
	 * 分层规则：按已输入的 token 数决定补哪一层
	 * - 第 1 个 token → 一级子命令
	 * - 第 2 个 token → 二级动作（scheme/rate/calendar）
	 * - 第 3+ 个 token → 动态 id（provider/model/id/field/value）
	 *
	 * 任何异常都吞掉并降级为静态候选：补全抛错会破坏输入框体验。
	 */
	private completeArguments(argumentText: string): AutocompleteItem[] | null {
		try {
			return this.buildCompletions(argumentText);
		} catch {
			// 文件损坏等异常：退化为一级子命令候选
			return this.toItems(PRICE_SUBCOMMANDS.map((s) => ({ value: s.name, description: s.summary })), "");
		}
	}

	/**
	 * 补全主逻辑（异常已在上层兜底）。
	 *
	 * 统一模型：把输入拆成 tokens，先求出"当前正在补的位置参数下标" slot，
	 * 再按该位置的语义（provider/model/plan/direction/id/field/value）给候选。
	 * 「末尾有空格」= 前一 token 已完成，正在开新 token；否则正在补最后一个 token。
	 */
	private buildCompletions(argumentText: string): AutocompleteItem[] | null {
		const endsWithSpace = /\s$/.test(argumentText);
		const trimmed = argumentText.trim();
		const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);

		// 已完成的位置参数（末尾无空格时，最后一个 token 是"正在补"的，不算完成）
		const settled = endsWithSpace || trimmed === "" ? tokens : tokens.slice(0, -1);
		// 正在补的 token 前缀（末尾有空格时为空）
		const prefix = endsWithSpace || trimmed === "" ? "" : tokens[tokens.length - 1];

		// 第 1 个位置：一级子命令
		if (settled.length === 0) {
			return this.toItems(PRICE_SUBCOMMANDS.map((s) => ({ value: s.name, description: s.summary })), prefix);
		}

		const spec = findSubcommand(settled[0]);
		if (!spec) return null;

// 判断是否已输入二级动作（scheme create / rate set / calendar add）
			const action = spec.children?.find((c) => c.name === settled[1]);
		// 位置参数语义表：有 action 用 action 的，否则用子命令自身的
		const positionals = action ? (action.args ?? []) : (spec.args ?? []);
		// 已消费的位置参数个数（减去子命令名，以及已输入的动作名）
		const consumed = settled.slice(action ? 2 : 1);
		const slotIndex = consumed.length;

		// 第 2 个位置且尚未输入动作：补动作名（已输入动作时走位置语义）
		if (!action && slotIndex === 0 && spec.children?.length) {
			return this.toItems(spec.children.map((c) => ({ value: c.name, description: c.summary })), prefix);
		}

		// 其余：按位置语义给动态候选
		const slot = positionals[slotIndex];
		return this.completeDynamic(spec.name, slot, consumed, prefix);
	}

	/** 按位置参数语义给动态候选（读当前配置取真实 id） */
	private completeDynamic(name: string, slot: string | undefined, consumed: string[], prefix: string): AutocompleteItem[] | null {
		const schema = readPricing(this.filePath);
		const providers = Object.keys(schema.providers);
		const modelsOf = (p: string): string[] => Object.keys(schema.providers[p]?.models ?? {});

		switch (slot) {
			case "provider":
				return this.toItems(
					providers.map((p) => ({ value: p, description: `${modelsOf(p).length} 个模型` })),
					prefix,
				);
			case "model": {
				// 若 provider 已输入，只列该 provider 的模型；否则列全部
				const pickedProvider = consumed[consumed.indexOf("provider") + 1];
				void pickedProvider;
				const scoped = consumed[0] && schema.providers[consumed[0]] ? modelsOf(consumed[0]) : undefined;
				const all = providers.flatMap((p) => modelsOf(p).map((m) => ({ value: m, description: `${p}/${m}` })));
				const items = scoped ? scoped.map((m) => ({ value: m, description: `${consumed[0]}/${m}` })) : all;
				return this.toItems(items, prefix);
			}
			case "field":
				return this.toItems(PRICE_FIELDS.map((f) => ({ value: f })), prefix);
			case "id":
				return this.toItems(this.registryIds(name, schema), prefix);
			default:
				// 无位置参数语义的子命令（list/help）不补
				return null;
		}
	}

	/** 按子命令取对应注册表的已有 id 候选 */
	private registryIds(name: string, schema: PricingSchema): Array<{ value: string; description?: string }> {
		switch (name) {
			case "scheme":
				return Object.entries(schema.plans).map(([id, p]) => ({ value: id, description: p.name }));
			case "rate":
				return Object.entries(schema.prices).map(([id, p]) => ({ value: id, description: p.name }));
			case "calendar":
				return Object.entries(schema.calendars).map(([id, c]) => ({ value: id, description: c.name }));
			default:
				return [];
		}
	}

	/** 前缀过滤（忽略大小写）+ 去空值；无匹配返回 null（pi 约定） */
	private toItems(candidates: Array<{ value: string; description?: string }>, prefix: string): AutocompleteItem[] | null {
		const lower = prefix.toLowerCase();
		const filtered = candidates
			.filter((c) => c.value !== "")
			.filter((c) => c.value.toLowerCase().startsWith(lower));
		if (filtered.length === 0) return null;
		return filtered.map((c) => ({
			value: c.value,
			label: c.value,
			...(c.description ? { description: c.description } : {}),
		}));
	}

	private async showModel(provider: string | undefined, model: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		if (!provider || !model) {
			ctx.ui.notify("用法: /price model <provider> <model>", "info");
			return;
		}
		// TUI 下以 Markdown 详情只读页呈现（InfoPage）；headless 回退纯文本
		if (await this.drawer.open(ctx, "model", { provider, model })) return;
		ctx.ui.notify(renderModelDetail(provider, model, this.filePath), "info");
	}

	/**
	 * /price ai [on|off]：显式启用/停用 AI 编辑模式（会话级）。
	 *
	 * 启用 = 把 price_* 加入 active tools（未启用时模型看不到也调不到）；
	 * 停用 = 从 active tools 移除并清空服务实例。
	 */
	private async aiOp(action: string | undefined, pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		switch (action) {
			case "off":
				this.disableAgent(pi, ctx);
				break;
			case "on":
			case undefined:
				await this.enableAgent(pi, ctx);
				break;
			default:
				ctx.ui.notify("用法: /price ai [on|off]", "info");
		}
	}

	/** 启用 AI 编辑模式：先征得用户同意，再激活工具 */
	private async enableAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify("AI 编辑模式需要交互式界面（TUI），当前环境不支持。", "warning");
			return;
		}
		if (this.agentTools.enabled) {
			ctx.ui.notify("AI 编辑模式已启用。让 agent 读取价格文档并帮你修改即可；/price ai off 可停用。", "info");
			return;
		}
		const ok = await ctx.ui.confirm(
			"启用 AI 编辑模式",
			`本次会话内允许 agent 修改计费配置（${this.filePath ?? "~/.pi/model-pricing.json"}）。\n\n所有改动先进内存草稿，首次落盘前会再次向你确认。`,
		);
		if (!ok) {
			ctx.ui.notify("已取消，未启用 AI 编辑模式。", "info");
			return;
		}
		this.agentTools.enable();
		pi.setActiveTools([...new Set([...pi.getActiveTools(), ...PRICING_AGENT_TOOL_NAMES])]);
		ctx.ui.notify("AI 编辑模式已启用。现在可以让 agent 读取价格文档并修改配置。", "info");
	}

	/** 停用 AI 编辑模式：移除工具并清空服务实例 */
	private disableAgent(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
		if (!this.agentTools.enabled) {
			ctx.ui.notify("AI 编辑模式未启用。", "info");
			return;
		}
		this.agentTools.disable();
		const remove = new Set<string>(PRICING_AGENT_TOOL_NAMES);
		pi.setActiveTools(pi.getActiveTools().filter((name) => !remove.has(name)));
		ctx.ui.notify("AI 编辑模式已停用（未保存的草稿已丢弃）。", "info");
	}

	/** /price scheme [<id>] | scheme create <id> <name> | scheme duplicate <id> | scheme delete <id> */
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
			ctx.ui.notify("用法: /price scheme create <plan-id> [name]", "info");
			return;
		}
		try {
			let created = false;
			updatePricing((data) => {
				if (data.plans[planId]) throw new Error(`方案已存在: ${planId}`);
				const firstPrice = Object.keys(data.prices)[0];
				if (!firstPrice) throw new Error("价格注册表为空，请先 /price rate create");
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
			ctx.ui.notify("用法: /price scheme duplicate <plan-id>", "info");
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
			ctx.ui.notify("用法: /price scheme delete <plan-id>", "info");
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
		const bad = dates.find((d) => !isValidCalendarDate(d));
		if (bad) {
			ctx.ui.notify(`无效日期: ${bad}（需 YYYY-MM-DD 或 MM-DD，且月份 01-12、日期合法）`, "info");
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

	/** 新建价格实体：/price rate create <id> <name>（初始价 0，用 rate set 补） */
	private createPrice(priceId: string | undefined, name: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId) {
			ctx.ui.notify("用法: /price rate create <price-id> [name]\n  建后可用 /price rate set 修改数值", "info");
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
		ctx.ui.notify(`已新建价格 ${priceId}（初值 0，可 /price rate set ${priceId} output <value>）`, "info");
	}

	private setPrice(priceId: string | undefined, field: string | undefined, value: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId || !field || !value) {
			ctx.ui.notify("用法: /price rate set <price-id> <input.miss|input.hit|output> <value>\n  例: /price rate set deepseek-peak input.miss 2", "info");
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
		ctx.ui.notify(`已修改价格 ${priceId} ${f} = ${v}（/price rate 查看）`, "info");
	}

	private deletePrice(priceId: string | undefined, ctx: ExtensionCommandContext): void {
		if (!priceId) {
			ctx.ui.notify("用法: /price rate delete <price-id>", "info");
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
}