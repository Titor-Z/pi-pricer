/**
 * AI 辅助配置的服务层：把语义动作作用到 PricingDraft 内存态，产出 diff，
 * 确认后落盘。全链路无 TUI 依赖，可直接单测。
 *
 * 安全边界（本模块的存在意义）：
 * - agent 只能提交结构化动作，不能整份覆盖 JSON
 * - 所有改动先进内存 draft，validate + 引用保护通过才允许落盘
 * - 落盘走 withFileMutationQueue，与内置 edit/write 共享同一文件队列
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { PricingDraft } from "./pricing-draft.ts";
import { price, describeSchedule } from "./pricing-desc.ts";
import type { PricingAction } from "./pricing-agent-actions.ts";
import type { PricingPlan, PricingRule, PricingSchema, Schedule } from "./pricing-types.ts";

/** 单个动作的执行结果 */
export interface ActionOutcome {
	/** 动作 kind（人读用） */
	kind: string;
	/** 动作的简短描述（成功/失败都给出，便于 agent 与用户定位） */
	summary: string;
	/** 是否成功 */
	ok: boolean;
	/** 失败原因（ok=true 时为空串） */
	reason: string;
}

/** applyActions 的汇总结果：失败不中断，逐条记录 */
export interface ApplyResult {
	/** 成功执行的动作描述 */
	applied: string[];
	/** 失败的动作与原因 */
	errors: { action: string; reason: string }[];
	/** 逐条结果（含成功项，供工具渲染完整审计） */
	outcomes: ActionOutcome[];
}

/** 落盘结果 */
export interface CommitResult {
	ok: boolean;
	reason: string;
}

/** 默认时区（与 schema 默认一致） */
const DEFAULT_TIMEZONE = "Asia/Shanghai";

/**
 * 把动作里的 schedule 字段折叠成完整 Schedule 对象。
 * agent 只需给关心的字段，其余取默认（空 weekdays/ranges = 总是匹配）。
 */
function toSchedule(input: {
	timezone?: string;
	weekdays?: number[];
	ranges?: [string, string][];
	calendar?: string;
	calendarMode?: "include" | "exclude";
	includeDates?: string[];
	excludeDates?: string[];
}): Schedule {
	const schedule: Schedule = {
		timezone: input.timezone?.trim() || DEFAULT_TIMEZONE,
		weekdays: [...(input.weekdays ?? [])],
		ranges: (input.ranges ?? []).map(([s, e]) => [s, e] as [string, string]),
	};
	if (input.calendar && input.calendarMode) {
		schedule.calendar = input.calendar;
		schedule.calendarMode = input.calendarMode;
	}
	if (input.includeDates?.length) schedule.includeDates = [...input.includeDates];
	if (input.excludeDates?.length) schedule.excludeDates = [...input.excludeDates];
	return schedule;
}

/** 把 upsertPlan 的规则输入转成 PricingRule */
function toRule(input: PricingAction & { kind: "upsertPlan" }): (r: (typeof input)["rules"][number]) => PricingRule {
	return (r) => {
		const rule: PricingRule = { schedule: toSchedule(r), price: r.price };
		if (r.validUntil?.trim()) rule.validUntil = r.validUntil.trim();
		return rule;
	};
}

/** 动作 → 人读摘要（成功与失败都用它，避免两套文案） */
function summarize(action: PricingAction): string {
	switch (action.kind) {
		case "setPriceField":
			return `价格 ${action.priceId} 的 ${action.field} 设为 ${price(action.value)}`;
		case "upsertPrice":
			return `价格实体 ${action.priceId}（${action.name}）：miss ${price(action.inputMiss)} / hit ${price(action.inputHit)} / 输出 ${price(action.output)}`;
		case "upsertPlan":
			return `方案 ${action.planId}（${action.name}）共 ${action.rules.length} 条规则`;
		case "setRulePrice":
			return `方案 ${action.planId} 第 ${action.ruleIndex + 1} 条规则改用价格 ${action.priceId}`;
		case "bindModel":
			return `模型 ${action.provider}/${action.model} 绑定方案 ${action.planId}`;
		case "unbindModel":
			return `模型 ${action.provider}/${action.model} 解除绑定方案 ${action.planId}`;
		case "moveBinding":
			return `模型 ${action.provider}/${action.model} 的绑定 ${action.planId} 移到 ${action.dir}`;
		case "setAlias":
			return action.alias.trim() === ""
				? `模型 ${action.provider}/${action.model} 清除别名`
				: `模型 ${action.provider}/${action.model} 别名设为 ${action.alias}`;
		case "upsertCalendar":
			return `日历 ${action.calendarId}（${action.name}）共 ${action.dates.length} 个日期`;
		case "addCalendarDates":
			return `日历 ${action.calendarId} 追加 ${action.dates.length} 个日期`;
	}
}

/**
 * AI 辅助配置服务：持有 draft，提供 get / apply / diff / commit / discard。
 * 每次构造都从磁盘重读，避免与 TUI 会话交叉污染。
 */
export class PricingAgentService {
	/** 内存编辑会话（复用 TUI 同款 draft：validate + 引用保护） */
	private readonly draft: PricingDraft;

	constructor(private readonly filePath?: string) {
		this.draft = new PricingDraft(filePath);
	}

	/** 当前配置的语义摘要（agent 读取现有结构用） */
	getSummary(): string {
		const data = this.draft.snapshot();
		const lines: string[] = [];
		lines.push(`配置文件：${this.filePath ?? "~/.pi/model-pricing.json"}`);
		lines.push(`价格实体：${this.listKeys(data.prices)}`);
		lines.push(`方案：${this.listKeys(data.plans)}`);
		lines.push(`日历：${this.listKeys(data.calendars)}`);
		lines.push("");
		lines.push(this.describeProviders(data));
		return lines.join("\n");
	}

	/** 当前配置全量（agent 需要精确结构时用） */
	getSnapshot(): PricingSchema {
		return this.draft.snapshot();
	}

	/** 是否有未保存改动 */
	get isDirty(): boolean {
		return this.draft.isDirty;
	}

	/**
	 * 批量应用语义动作。单条失败不中断，最后汇总。
	 * 这样 agent 一次提交多个动作时能拿到完整反馈，而不是只看到第一条错误。
	 */
	applyActions(actions: PricingAction[]): ApplyResult {
		const outcomes: ActionOutcome[] = [];
		for (const action of actions) {
			outcomes.push(this.applyOne(action));
		}
		return {
			applied: outcomes.filter((o) => o.ok).map((o) => o.summary),
			errors: outcomes.filter((o) => !o.ok).map((o) => ({ action: o.summary, reason: o.reason })),
			outcomes,
		};
	}

	/** 单条动作分发：每个 kind 对应一个 draft mutator */
	private applyOne(action: PricingAction): ActionOutcome {
		const base = { kind: action.kind, summary: summarize(action) };
		switch (action.kind) {
			case "setPriceField": {
				const ok = this.draft.setPriceField(action.priceId, action.field, action.value);
				return { ...base, ok, reason: ok ? "" : `价格实体 "${action.priceId}" 不存在` };
			}
			case "upsertPrice": {
				const ok = this.draft.upsertPrice(action.priceId, {
					name: action.name,
					input: { miss: action.inputMiss, hit: action.inputHit },
					output: action.output,
				});
				return { ...base, ok, reason: ok ? "" : "价格实体 id 不能为空" };
			}
			case "upsertPlan": {
				const plan: PricingPlan = { name: action.name, rules: action.rules.map(toRule(action)) };
				const ok = this.draft.upsertPlan(action.planId, plan);
				return { ...base, ok, reason: ok ? "" : "方案 id 不能为空" };
			}
			case "setRulePrice": {
				const ok = this.draft.setRulePrice(action.planId, action.ruleIndex, action.priceId);
				return { ...base, ok, reason: ok ? "" : `方案 "${action.planId}" 第 ${action.ruleIndex + 1} 条规则或价格 "${action.priceId}" 不存在` };
			}
			case "bindModel": {
				const ok = this.draft.addBinding(action.provider, action.model, action.planId);
				return { ...base, ok, reason: ok ? "" : `模型 "${action.provider}/${action.model}" 或方案 "${action.planId}" 不存在（或已绑定且启用）` };
			}
			case "unbindModel": {
				const ok = this.draft.removeBinding(action.provider, action.model, action.planId);
				return { ...base, ok, reason: ok ? "" : `模型 "${action.provider}/${action.model}" 未绑定方案 "${action.planId}"` };
			}
			case "moveBinding": {
				const ok = this.draft.moveBinding(action.provider, action.model, action.planId, action.dir);
				return { ...base, ok, reason: ok ? "" : `模型 "${action.provider}/${action.model}" 未绑定方案 "${action.planId}"` };
			}
			case "setAlias": {
				const ok = this.draft.setAlias(action.provider, action.model, action.alias);
				return { ...base, ok, reason: ok ? "" : `模型 "${action.provider}/${action.model}" 不存在` };
			}
			case "upsertCalendar": {
				const ok = this.draft.upsertCalendar(action.calendarId, { name: action.name, dates: [...action.dates] });
				return { ...base, ok, reason: ok ? "" : "日历 id 不能为空" };
			}
			case "addCalendarDates": {
				const ok = this.draft.addCalendarDates(action.calendarId, action.dates);
				return { ...base, ok, reason: ok ? "" : `日历 "${action.calendarId}" 不存在` };
			}
		}
	}

	/** 未保存改动的面（状态栏/报告用） */
	get changedAreas(): string[] {
		return this.draft.changedAreas;
	}

	/**
	 * 人类可读的改动预览（改前 vs 改后对比）。
	 * 无改动时返回提示文案。
	 */
	diffPreview(): string {
		if (!this.draft.isDirty) return "当前没有未保存的改动。";
		const after = this.draft.snapshot();
		const lines: string[] = [`将要写入的文件：${this.filePath ?? "~/.pi/model-pricing.json"}`, ""];
		lines.push(`涉及面：${this.draft.changedAreas.join("、")}`);
		lines.push("");
		lines.push("改动后的配置：");
		lines.push(this.describeProviders(after));
		return lines.join("\n");
	}

	/**
	 * 落盘：先跑 draft 的 validate + 引用保护，通过才写。
	 * 写操作走 withFileMutationQueue，避免与内置 edit/write 并发覆盖。
	 */
	async commit(): Promise<CommitResult> {
		const result = await withFileMutationQueue(this.filePath ?? "", async () => this.draft.save());
		return { ok: result.ok, reason: result.reason };
	}

	/** 丢弃全部未保存改动（从磁盘重读） */
	discard(): void {
		this.draft.reset();
	}

	/** 渲染厂商 → 模型 → 绑定 → 规则（get/diff 共用，保证两处文案一致） */
	private describeProviders(data: PricingSchema): string {
		const lines: string[] = [];
		for (const [provId, prov] of Object.entries(data.providers)) {
			lines.push(`[${provId}]`);
			for (const [modelId, conf] of Object.entries(prov.models)) {
				const alias = conf.alias ? `（别名 ${conf.alias}）` : "";
				lines.push(`  ${modelId}${alias}`);
				for (const [index, binding] of conf.plans.entries()) {
					const state = binding.enabled ? "启用" : "停用";
					lines.push(`    #${index + 1} [${state}] ${binding.plan}`);
				}
			}
		}
		lines.push("");
		lines.push("方案规则：");
		lines.push(this.describePlans(data));
		return lines.join("\n");
	}

	/** 渲染所有方案的规则（含价格数值与时间条件） */
	private describePlans(data: PricingSchema): string {
		const lines: string[] = [];
		for (const [planId, plan] of Object.entries(data.plans)) {
			lines.push(`· ${planId}（${plan.name}）`);
			for (const [index, rule] of plan.rules.entries()) {
				lines.push(`    ${index + 1}. ${describeSchedule(rule.schedule)} → ${this.describePrice(data, rule)}`);
			}
		}
		return lines.join("\n");
	}

	/** 规则引用的价格实体渲染（价格缺失时给出显式警告，便于 agent 自纠） */
	private describePrice(data: PricingSchema, rule: PricingRule): string {
		const entity = data.prices[rule.price];
		if (!entity) return `${rule.price}（⚠ 价格实体不存在）`;
		return `${rule.price}：miss ${price(entity.input.miss)} / hit ${price(entity.input.hit)} / 输出 ${price(entity.output)}`;
	}

	/** 注册表 key 渲染（空表给出明确文案） */
	private listKeys(record: Record<string, unknown>): string {
		const keys = Object.keys(record);
		return keys.length > 0 ? keys.join("、") : "（空）";
	}
}
