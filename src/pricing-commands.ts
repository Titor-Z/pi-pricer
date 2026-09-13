/**
 * /price 命令实现（v5）：6 个子命令 = 无参 / rate / calendar / rule / plan / ai。
 *
 * 职责：管理规则制定与存储（CRUD），不展示"当前什么价"（那是 pi-usager 的事）。
 * 所有写操作走 Database.transaction（校验 + 乐观锁 + 原子写，失败整笔回滚）。
 * 支持 filePath 注入，便于单测隔离。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Database } from "./db/database.ts";
import {
	checkCalendarDeletable,
	checkPlanDeletable,
	checkRateDeletable,
	checkRuleDeletable,
} from "./db/validate.ts";
import type {
	CalendarDoc,
	ModelDoc,
	PlanDoc,
	PricingSchema,
	RateDoc,
	RuleDoc,
} from "./pricing-types.ts";
import {
	PRICE_AI_TOOL_NAMES,
	PRICE_SUBCOMMANDS,
	RATE_FIELDS,
	findSubcommand,
} from "./pricing-cli-spec.ts";
import type { PricingAgentTools } from "./pricing-agent-tool.ts";
import { openPricingDrawer, type DrawerPage } from "./tui/pricing-drawer.ts";

/** 补全项（与 pi-tui AutocompleteItem 同形，避免直接依赖其类型） */
export interface CompletionItem {
	value: string;
	label: string;
	description?: string;
}

// ── 解析辅助 ──────────────────────────────────────────────────────────────

/** 分词：按空白切分，双引号包裹的片段保持整体（支持 name 含空格） */
function tokenize(input: string): string[] {
	const out: string[] = [];
	let current = "";
	let quoted = false;
	for (const ch of input) {
		if (ch === "\"") {
			quoted = !quoted;
			continue;
		}
		if (!quoted && /\s/.test(ch)) {
			if (current !== "") out.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current !== "") out.push(current);
	return out;
}

/** 解析结果：位置参数 + 具名选项（同名选项可重复，便于多个日历/日期） */
interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string[]>;
}

/** 解析 `--key value` 选项与位置参数 */
function parseArgs(tokens: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string[]>();
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const key = token.slice(2);
		const next = tokens[i + 1];
		if (next === undefined || next.startsWith("--")) {
			flags.set(key, [...(flags.get(key) ?? [])]);
			continue;
		}
		flags.set(key, [...(flags.get(key) ?? []), next]);
		i += 1;
	}
	return { positionals, flags };
}

/** 取布尔型选项值（`--key v` 的首个值） */
function flagValue(flags: ParsedArgs["flags"], key: string): string | undefined {
	return flags.get(key)?.[0];
}

/** 展开逗号/空白分隔的多值选项 */
function flagList(flags: ParsedArgs["flags"], key: string): string[] {
	return (flags.get(key) ?? []).flatMap((v) => v.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

/** 解析星期表达式："1-5" / "1,3,5" / "7" → [1,2,3,4,5] 等 */
function parseWeekdays(expr: string): number[] {
	const out = new Set<number>();
	for (const part of expr.split(",").map((s) => s.trim()).filter((s) => s !== "")) {
		const range = /^(\d)-(\d)$/.exec(part);
		if (range) {
			for (let d = Number(range[1]); d <= Number(range[2]); d += 1) out.add(d);
			continue;
		}
		if (/^[1-7]$/.test(part)) out.add(Number(part));
	}
	return [...out].sort((a, b) => a - b);
}

/** 解析时段："09:00-12:00,14:00-18:00" → [["09:00","12:00"],["14:00","18:00"]] */
function parseRanges(expr: string): [string, string][] {
	return expr
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "")
		.map((part) => {
			const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(part);
			if (!m) throw new Error(`时段格式非法："${part}"（应为 HH:MM-HH:MM）`);
			return [m[1], m[2]] as [string, string];
		});
}

/** 解析日期列表："01-01,10-01" 或 "01-01 10-01" */
function parseDates(expr: string): string[] {
	return expr.split(/[,\s]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/** 名称含空白时补全值需加引号 */
function quoteIfNeeded(value: string): string {
	return /\s/.test(value) ? `"${value}"` : value;
}

// ── 渲染（headless 文本） ─────────────────────────────────────────────────

/** 填充到指定显示宽度（按字符数，够用即可） */
function pad(text: string, width: number): string {
	const length = [...text].length;
	return length >= width ? text : text + " ".repeat(width - length);
}

/** 模型列表：有方案的模型，按 (provider, model) 字母序 */
export function renderModelList(schema: PricingSchema): string {
	if (schema.models.length === 0) return "尚无模型绑定方案。用 /price plan bind <provider> <model> <planName> 绑定。";
	const lines = ["模型计费配置（已设定方案的模型 · 字母序）", ""];
	const ordered = [...schema.models].sort((a, b) =>
		`${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
	);
	const width = Math.max(...ordered.map((m) => `${m.provider}/${m.model}`.length));
	for (const model of ordered) {
		const plan = schema.plans.find((p) => p._id === model.planId);
		const state = !plan ? "方案缺失" : model.enabled === false ? "已禁用" : "启用";
		const alias = plan?.alias ? `（${plan.alias}）` : "";
		const label = `${model.provider}/${model.model}`;
		lines.push(`  ${pad(label, width)}  → ${plan?.name ?? model.planId}${alias}  [${state}]`);
	}
	return lines.join("\n");
}

/** 价格表 */
export function renderRateList(schema: PricingSchema): string {
	if (schema.rates.length === 0) return "价格表为空。用 /price rate add <name> <miss> <hit> <output> 新建。";
	const lines = ["价格表", ""];
	const width = Math.max(...schema.rates.map((r) => [...r.name].length));
	for (const rate of schema.rates) {
		lines.push(`  ${pad(rate.name, width)}  未命中 ${rate.inputMiss} · 命中 ${rate.inputHit} · 输出 ${rate.output}`);
	}
	return lines.join("\n");
}

/** 日历表（含被哪些规则引用） */
export function renderCalendarList(schema: PricingSchema): string {
	if (schema.calendars.length === 0) return "日历表为空。用 /price calendar add <name> \"<日期...>\" 新建。";
	const lines = ["日历表", ""];
	for (const cal of schema.calendars) {
		const usedBy = referencedRuleNames(schema, cal._id, "calendar");
		const refs = usedBy.length > 0 ? `  ← ${usedBy.join("、")}` : "";
		lines.push(`  ${cal.name}（${cal.dates.length} 个日期）${refs}`);
		lines.push(`    ${cal.dates.join(", ")}`);
	}
	return lines.join("\n");
}

/** 规则表（含被哪些方案引用） */
export function renderRuleList(schema: PricingSchema): string {
	if (schema.rules.length === 0) return "规则表为空。用 /price rule add <name> <rateName> 新建。";
	const lines = ["规则表", ""];
	for (const rule of schema.rules) {
		const rate = schema.rates.find((r) => r._id === rule.rateId);
		const usedBy = schema.plans.filter((p) => p.ruleIds.includes(rule._id)).map((p) => p.name);
		const refs = usedBy.length > 0 ? `  ← ${usedBy.join("、")}` : "";
		lines.push(`  ${rule.name}  → 价格「${rate?.name ?? rule.rateId}」${refs}`);
		lines.push(`    ${describeRule(rule, schema)}`);
	}
	return lines.join("\n");
}

/** 方案表（含引用它的模型） */
export function renderPlanList(schema: PricingSchema): string {
	if (schema.plans.length === 0) return "方案表为空。用 /price plan add <name> 新建。";
	const lines = ["方案表", ""];
	for (const plan of schema.plans) {
		const models = schema.models.filter((m) => m.planId === plan._id).map((m) => `${m.provider}/${m.model}`);
		const alias = plan.alias ? `（${plan.alias}）` : "";
		lines.push(`  ${plan.name}${alias}  ${plan.ruleIds.length} 条规则`);
		if (models.length > 0) lines.push(`    ← ${models.join("、")}`);
	}
	return lines.join("\n");
}

/** 规则的中文摘要（时间条件 + 时效） */
function describeRule(rule: RuleDoc, schema: PricingSchema): string {
	const parts: string[] = [];
	parts.push(rule.weekdays.length > 0 ? `周 ${rule.weekdays.join(",")}` : "每天");
	const ranges = rule.ranges.length > 0 ? rule.ranges.map(([s, e]) => `${s}-${e}`).join(" / ") : "全天";
	parts.push(ranges);
	if (rule.includeCalendars.length > 0) {
		parts.push(`仅 ${rule.includeCalendars.map((id) => schema.calendars.find((c) => c._id === id)?.name ?? id).join("、")}`);
	}
	if (rule.excludeCalendars.length > 0) {
		parts.push(`排除 ${rule.excludeCalendars.map((id) => schema.calendars.find((c) => c._id === id)?.name ?? id).join("、")}`);
	}
	if (rule.includeDates.length > 0) parts.push(`指定日期 ${rule.includeDates.join("、")}`);
	if (rule.excludeDates.length > 0) parts.push(`排除日期 ${rule.excludeDates.join("、")}`);
	if (rule.validUntil) parts.push(`有效期至 ${rule.validUntil}`);
	parts.push(`时区 ${rule.timezone}`);
	return parts.join(" · ");
}

/** 某日历被哪些规则引用 */
function referencedRuleNames(schema: PricingSchema, id: string, kind: "calendar"): string[] {
	return schema.rules
		.filter((r) => (kind === "calendar" ? r.includeCalendars.includes(id) || r.excludeCalendars.includes(id) : false))
		.map((r) => r.name);
}

/** help 文本（从命令规格派生） */
export function renderHelp(): string {
	const lines = ["/price — 模型计费配置（v5）", "", "  /price                     列出已设定方案的模型（字母序）"];
	for (const sub of PRICE_SUBCOMMANDS) {
		const children = (sub.children ?? []).map((c) => `      /price ${sub.name} ${c.name.padEnd(10)} ${c.summary}`);
		lines.push(`  /price ${sub.name.padEnd(10)} ${sub.summary}`);
		lines.push(...children);
	}
	return lines.join("\n");
}

// ── 命令实现 ──────────────────────────────────────────────────────────────

/** /price 命令：挂载、分发、补全、帮助 */
export class PricingCommands {
	/** 会话内 AI 编辑模式是否启用（本地标记，配合 pi 的 active tools） */
	private aiEnabled = false;

	constructor(
		private readonly filePath?: string,
		/** AI 工具集（批次④注入；未注入时仅切换 active tools） */
		private readonly aiTools?: PricingAgentTools,
	) {}

	/** 打开数据库（每次命令取最新磁盘状态与乐观锁基线） */
	private open(): Database {
		return Database.open(this.filePath);
	}

	/** 挂载到 pi：注册 /price 命令 */
	mount(pi: ExtensionAPI): void {
		pi.registerCommand("price", {
			description: "模型计费配置（rate / calendar / rule / plan / ai）",
			getArgumentCompletions: (prefix) => this.completions(prefix),
			handler: (args, ctx) => this.handle(args, ctx, pi),
		});
	}

	/** 命令入口：分发到各子命令（TUI 下无二级动作时开抽屉） */
	private async handle(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
		const tokens = tokenize(args);
		// TUI 直达：/price 或 /price <page>（不带二级动作）直接开抽屉到对应页
		if (ctx.mode === "tui") {
			const direct = this.drawerPageFor(tokens);
			if (direct !== null) {
				await openPricingDrawer(ctx, { initial: direct, filePath: this.filePath });
				return;
			}
		}
		if (tokens.length === 0) {
			this.notify(ctx, renderModelList(this.open().snapshot()));
			return;
		}
		const [sub, ...rest] = tokens;
		try {
			switch (sub) {
				case "rate":
					this.cmdRate(rest, ctx);
					break;
				case "calendar":
					this.cmdCalendar(rest, ctx);
					break;
				case "rule":
					this.cmdRule(rest, ctx);
					break;
				case "plan":
					this.cmdPlan(rest, ctx);
					break;
				case "ai":
					await this.cmdAi(rest, ctx, pi);
					break;
				default:
					this.notify(ctx, `未知子命令：${sub}\n\n${renderHelp()}`, "warning");
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.notify(ctx, `操作失败：${message}`, "error");
		}
	}

	/** 通知用户（info 默认） */
	private notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		ctx.ui.notify(message, type);
	}

	/**
	 * 判断是否应该开抽屉：
	 * - 无参数 → 模型列表；
	 * - 仅有页面子命令（rate/calendar/rule/plan）→ 对应页；
	 * - 带二级动作（如 rate add）→ 返回 null（走文本执行，便于脚本化）。
	 */
	private drawerPageFor(tokens: string[]): DrawerPage | null {
		if (tokens.length === 0) return "models";
		if (tokens.length > 1) return null;
		switch (tokens[0]) {
			case "rate":
			case "calendar":
			case "rule":
			case "plan":
				return tokens[0];
			default:
				return null;
		}
	}

	/** 查找价格（按 name） */
	private findRate(schema: PricingSchema, name: string): RateDoc {
		const rate = schema.rates.find((r) => r.name === name);
		if (!rate) throw new Error(`价格「${name}」不存在`);
		return rate;
	}

	/** 查找日历（按 name） */
	private findCalendar(schema: PricingSchema, name: string): CalendarDoc {
		const cal = schema.calendars.find((c) => c.name === name);
		if (!cal) throw new Error(`日历「${name}」不存在`);
		return cal;
	}

	/** 查找规则（按 name） */
	private findRule(schema: PricingSchema, name: string): RuleDoc {
		const rule = schema.rules.find((r) => r.name === name);
		if (!rule) throw new Error(`规则「${name}」不存在`);
		return rule;
	}

	/** 查找方案（按 name） */
	private findPlan(schema: PricingSchema, name: string): PlanDoc {
		const plan = schema.plans.find((p) => p.name === name);
		if (!plan) throw new Error(`方案「${name}」不存在`);
		return plan;
	}

	// ── rate ──────────────────────────────────────────────────────────────

	/** /price rate <list|add|set|remove> */
	private cmdRate(args: string[], ctx: ExtensionCommandContext): void {
		const action = args[0] ?? "list";
		const parsed = parseArgs(args.slice(1));
		const db = this.open();
		switch (action) {
			case "list":
				this.notify(ctx, renderRateList(db.snapshot()));
				break;
			case "add": {
				const [name, miss, hit, output] = parsed.positionals;
				if (!name || miss === undefined || hit === undefined || output === undefined) {
					throw new Error("用法：/price rate add <name> <miss> <hit> <output>");
				}
				db.transaction((tx) => {
					tx.rates.ensureUniqueName(name);
					tx.rates.insertOne({
						name,
						inputMiss: Number(miss),
						inputHit: Number(hit),
						output: Number(output),
					});
				});
				this.notify(ctx, `已新建价格「${name}」`);
				break;
			}
			case "set": {
				const [name, field, value] = parsed.positionals;
				if (!name || !field || value === undefined) throw new Error("用法：/price rate set <name> <field> <value>");
				if (!RATE_FIELDS.includes(field as (typeof RATE_FIELDS)[number])) {
					throw new Error(`字段非法：${field}（可选 ${RATE_FIELDS.join(" / ")}）`);
				}
				db.transaction((tx) => {
					const rate = this.findRate(tx.snapshot(), name);
					tx.rates.updateOne(rate._id, { [field]: Number(value) } as Partial<RateDoc>);
				});
				this.notify(ctx, `已更新价格「${name}」的 ${field} = ${value}`);
				break;
			}
			case "remove": {
				const [name] = parsed.positionals;
				if (!name) throw new Error("用法：/price rate remove <name>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const rate = this.findRate(schema, name);
					const check = checkRateDeletable(schema, rate._id);
					if (!check.ok) throw new Error(check.reason);
					tx.rates.deleteOne(rate._id);
				});
				this.notify(ctx, `已删除价格「${name}」`);
				break;
			}
			default:
				this.notify(ctx, `未知动作：rate ${action}`, "warning");
		}
	}

	// ── calendar ──────────────────────────────────────────────────────────

	/** /price calendar <list|add|add-dates|remove> */
	private cmdCalendar(args: string[], ctx: ExtensionCommandContext): void {
		const action = args[0] ?? "list";
		const parsed = parseArgs(args.slice(1));
		const db = this.open();
		switch (action) {
			case "list":
				this.notify(ctx, renderCalendarList(db.snapshot()));
				break;
			case "add": {
				const [name, dates] = parsed.positionals;
				if (!name || dates === undefined) throw new Error('用法：/price calendar add <name> "<日期...>"');
				db.transaction((tx) => {
					tx.calendars.ensureUniqueName(name);
					tx.calendars.insertOne({ name, dates: parseDates(dates) });
				});
				this.notify(ctx, `已新建日历「${name}」`);
				break;
			}
			case "add-dates": {
				const [name, dates] = parsed.positionals;
				if (!name || dates === undefined) throw new Error('用法：/price calendar add-dates <name> "<日期...>"');
				db.transaction((tx) => {
					const cal = this.findCalendar(tx.snapshot(), name);
					const merged = [...new Set([...cal.dates, ...parseDates(dates)])];
					tx.calendars.updateOne(cal._id, { dates: merged });
				});
				this.notify(ctx, `已向日历「${name}」追加日期`);
				break;
			}
			case "remove": {
				const [name] = parsed.positionals;
				if (!name) throw new Error("用法：/price calendar remove <name>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const cal = this.findCalendar(schema, name);
					const check = checkCalendarDeletable(schema, cal._id);
					if (!check.ok) throw new Error(check.reason);
					tx.calendars.deleteOne(cal._id);
				});
				this.notify(ctx, `已删除日历「${name}」`);
				break;
			}
			default:
				this.notify(ctx, `未知动作：calendar ${action}`, "warning");
		}
	}

	// ── rule ──────────────────────────────────────────────────────────────

	/** /price rule <list|add|remove> */
	private cmdRule(args: string[], ctx: ExtensionCommandContext): void {
		const action = args[0] ?? "list";
		const parsed = parseArgs(args.slice(1));
		const db = this.open();
		switch (action) {
			case "list":
				this.notify(ctx, renderRuleList(db.snapshot()));
				break;
			case "add": {
				const [name, rateName] = parsed.positionals;
				if (!name || !rateName) {
					throw new Error("用法：/price rule add <name> <rateName> [--weekdays 1-5] [--ranges 09:00-12:00,...]");
				}
				const weekdaysExpr = flagValue(parsed.flags, "weekdays");
				const rangesExpr = flagValue(parsed.flags, "ranges");
				const includeCal = flagList(parsed.flags, "include-cal");
				const excludeCal = flagList(parsed.flags, "exclude-cal");
				const includeDates = flagList(parsed.flags, "include-dates");
				const excludeDates = flagList(parsed.flags, "exclude-dates");
				const validUntil = flagValue(parsed.flags, "valid-until");
				const timezone = flagValue(parsed.flags, "timezone") ?? "Asia/Shanghai";
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const rate = this.findRate(schema, rateName);
					tx.rules.ensureUniqueName(name);
					tx.rules.insertOne({
						name,
						rateId: rate._id,
						timezone,
						weekdays: weekdaysExpr ? parseWeekdays(weekdaysExpr) : [],
						ranges: rangesExpr ? parseRanges(rangesExpr) : [],
						includeCalendars: includeCal.map((n) => this.findCalendar(schema, n)._id),
						excludeCalendars: excludeCal.map((n) => this.findCalendar(schema, n)._id),
						includeDates,
						excludeDates,
						...(validUntil ? { validUntil } : {}),
					});
				});
				this.notify(ctx, `已新建规则「${name}」`);
				break;
			}
			case "remove": {
				const [name] = parsed.positionals;
				if (!name) throw new Error("用法：/price rule remove <name>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const rule = this.findRule(schema, name);
					const check = checkRuleDeletable(schema, rule._id);
					if (!check.ok) throw new Error(check.reason);
					tx.rules.deleteOne(rule._id);
				});
				this.notify(ctx, `已删除规则「${name}」`);
				break;
			}
			default:
				this.notify(ctx, `未知动作：rule ${action}`, "warning");
		}
	}

	// ── plan ──────────────────────────────────────────────────────────────

	/** /price plan <list|add|set-alias|add-rule|remove-rule|enable|disable|bind|remove> */
	private cmdPlan(args: string[], ctx: ExtensionCommandContext): void {
		const action = args[0] ?? "list";
		const parsed = parseArgs(args.slice(1));
		const db = this.open();
		switch (action) {
			case "list":
				this.notify(ctx, renderPlanList(db.snapshot()));
				break;
			case "add": {
				const [name, alias] = parsed.positionals;
				if (!name) throw new Error('用法：/price plan add <name> ["<alias>"]');
				const cleanAlias = alias?.trim() ?? "";
				db.transaction((tx) => {
					tx.plans.ensureUniqueName(name);
					tx.plans.insertOne({ name, ruleIds: [], ...(cleanAlias ? { alias: cleanAlias } : {}) });
				});
				this.notify(ctx, `已新建方案「${name}」（尚未纳入规则，请用 add-rule 添加）`);
				break;
			}
			case "set-alias": {
				const [name, alias] = parsed.positionals;
				if (!name || alias === undefined) throw new Error('用法：/price plan set-alias <name> "<alias>"');
				db.transaction((tx) => {
					const plan = this.findPlan(tx.snapshot(), name);
					tx.plans.updateOne(plan._id, { alias: alias.trim() === "" ? undefined : alias.trim() });
				});
				this.notify(ctx, `已更新方案「${name}」别名`);
				break;
			}
			case "add-rule": {
				const [planName, ruleName] = parsed.positionals;
				if (!planName || !ruleName) throw new Error("用法：/price plan add-rule <planName> <ruleName>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const plan = this.findPlan(schema, planName);
					const rule = this.findRule(schema, ruleName);
					if (!plan.ruleIds.includes(rule._id)) {
						tx.plans.updateOne(plan._id, { ruleIds: [...plan.ruleIds, rule._id] });
					}
				});
				this.notify(ctx, `已把规则「${ruleName}」纳入方案「${planName}」`);
				break;
			}
			case "remove-rule": {
				const [planName, ruleName] = parsed.positionals;
				if (!planName || !ruleName) throw new Error("用法：/price plan remove-rule <planName> <ruleName>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const plan = this.findPlan(schema, planName);
					const rule = this.findRule(schema, ruleName);
					tx.plans.updateOne(plan._id, { ruleIds: plan.ruleIds.filter((id) => id !== rule._id) });
				});
				this.notify(ctx, `已把规则「${ruleName}」移出方案「${planName}」`);
				break;
			}
			case "enable-model":
			case "disable-model": {
				const [provider, model] = parsed.positionals;
				if (!provider || !model) throw new Error(`用法：/price plan ${action} <provider> <model>`);
				const enabled = action === "enable-model";
				db.transaction((tx) => {
					const doc = tx.models.findOne((m) => m.provider === provider && m.model === model);
					if (!doc) throw new Error(`模型 ${provider}/${model} 未绑定任何方案`);
					tx.models.updateOne(doc._id, { enabled });
				});
				this.notify(ctx, `已${enabled ? "启用" : "禁用"}模型 ${provider}/${model}`);
				break;
			}
			case "bind": {
				const [provider, model, planName] = parsed.positionals;
				if (!provider || !model || !planName) throw new Error("用法：/price plan bind <provider> <model> <planName>");
				db.transaction((tx) => {
					const plan = this.findPlan(tx.snapshot(), planName);
					const existing = tx.models.findOne((m) => m.provider === provider && m.model === model);
					if (existing) tx.models.updateOne(existing._id, { planId: plan._id });
					else tx.models.insertOne({ provider, model, planId: plan._id, enabled: true });
				});
				this.notify(ctx, `已绑定 ${provider}/${model} → 方案「${planName}」`);
				break;
			}
			case "remove": {
				const [name] = parsed.positionals;
				if (!name) throw new Error("用法：/price plan remove <name>");
				db.transaction((tx) => {
					const schema = tx.snapshot();
					const plan = this.findPlan(schema, name);
					const check = checkPlanDeletable(schema, plan._id);
					if (!check.ok) throw new Error(check.reason);
					tx.plans.deleteOne(plan._id);
				});
				this.notify(ctx, `已删除方案「${name}」`);
				break;
			}
			default:
				this.notify(ctx, `未知动作：plan ${action}`, "warning");
		}
	}

	// ── ai ────────────────────────────────────────────────────────────────

	/** /price ai [on|off]：会话级启用 / 停用 AI 编辑模式 */
	private async cmdAi(args: string[], ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
		const action = args[0] ?? "on";
		const active = new Set(pi.getActiveTools());
		switch (action) {
			case "on": {
				if (!ctx.hasUI) {
					this.notify(ctx, "当前模式不支持交互确认，无法启用 AI 编辑模式。", "warning");
					return;
				}
				const ok = await ctx.ui.confirm("启用 AI 编辑模式？", "启用后，本次会话内 agent 可读取并修改计费配置（落盘前会再次确认）。");
				if (!ok) {
					this.notify(ctx, "已取消，未启用 AI 编辑模式。", "warning");
					return;
				}
				this.aiEnabled = true;
				this.aiTools?.setEnabled(true);
				// 去重：active 可能已含这些工具（重复启用 / 会话恢复了 active 集）——
				// 同名工具入列两份会让 provider 报 "Tool names must be unique"
				pi.setActiveTools([...new Set([...active, ...PRICE_AI_TOOL_NAMES])]);
				this.notify(ctx, "已启用 AI 编辑模式：agent 现可调用 price_get / price_apply / price_review / price_save / price_discard。");
				break;
			}
			case "off": {
				this.aiEnabled = false;
				this.aiTools?.setEnabled(false);
				pi.setActiveTools([...active].filter((name) => !PRICE_AI_TOOL_NAMES.includes(name as (typeof PRICE_AI_TOOL_NAMES)[number])));
				this.notify(ctx, "已停用 AI 编辑模式。");
				break;
			}
			default:
				this.notify(ctx, `未知动作：ai ${action}（可选 on / off）`, "warning");
		}
	}

	/** AI 编辑模式是否启用（供工具层判断） */
	get isAiEnabled(): boolean {
		return this.aiEnabled;
	}

	// ── 补全 ──────────────────────────────────────────────────────────────

	/**
	 * 命令补全：按 token 位置与语义给候选。
	 * 无参时列一级子命令；有空格后按位置给二级动作或动态 name。
	 */
	completions(argumentPrefix: string): CompletionItem[] {
		const tokens = tokenize(argumentPrefix);
		const endsWithSpace = /\s$/.test(argumentPrefix);
		const current = endsWithSpace ? "" : tokens.pop() ?? "";
		try {
			switch (tokens.length) {
				case 0:
					return filterSubcommands(current);
				case 1:
					return filterChildren(tokens[0], current);
				default:
					return this.dynamicCompletions(tokens, current);
			}
		} catch {
			// 补全不得抛错（会破坏输入体验）：异常时降级为空
			return [];
		}
	}

	/** 第三层及以后：按子命令与动作给动态 name 候选 */
	private dynamicCompletions(tokens: string[], current: string): CompletionItem[] {
		const [sub, action] = tokens;
		const schema = this.open().snapshot();
		const position = tokens.length - 2; // 已填的位置参数个数（不含当前输入）
		const names = (items: Array<{ name: string }>): CompletionItem[] =>
			items
				.filter((item) => item.name.startsWith(current))
				.map((item) => ({ value: quoteIfNeeded(item.name), label: item.name }));
		if (sub === "rate") {
			if (action === "set") return position === 0 ? names(schema.rates) : fieldCompletions(current);
			if (action === "remove") return names(schema.rates);
			return [];
		}
		if (sub === "calendar") return action === "add" ? [] : names(schema.calendars);
		if (sub === "rule") return action === "add" ? (position === 1 ? names(schema.rates) : []) : names(schema.rules);
		if (sub === "plan") {
			if (action === "bind") {
				if (position === 0 || position === 1) return [];
				return names(schema.plans);
			}
			return position === 0 ? names(schema.plans) : names(schema.rules);
		}
		return [];
	}
}

/** 一级子命令候选（前缀过滤） */
function filterSubcommands(prefix: string): CompletionItem[] {
	return PRICE_SUBCOMMANDS.filter((sub) => sub.name.startsWith(prefix)).map((sub) => ({
		value: sub.name,
		label: sub.name,
		description: sub.summary,
	}));
}

/** 二级动作候选 */
function filterChildren(subName: string, prefix: string): CompletionItem[] {
	const sub = findSubcommand(subName);
	if (!sub?.children) return [];
	return sub.children
		.filter((child) => child.name.startsWith(prefix))
		.map((child) => ({ value: child.name, label: child.name, description: child.summary }));
}

/** rate set 的字段候选 */
function fieldCompletions(prefix: string): CompletionItem[] {
	return RATE_FIELDS.filter((field) => field.startsWith(prefix)).map((field) => ({ value: field, label: field }));
}
