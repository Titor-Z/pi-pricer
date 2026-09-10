/**
 * 内存编辑会话（draft）：抽屉内所有编辑先改内存，Ctrl+S 时统一落盘。
 *
 * 为什么需要这一层：
 * - 用户要求"先写入内存，Ctrl+S 保存"，需要一个可撤销/可丢弃的中间态
 * - 保存前统一跑引用保护校验（checkPlanDeletable / checkPriceDeletable），
 *   避免删除被引用实体后文件进入脏状态
 * - 纯逻辑无 TUI 依赖，可直接单测
 */

import { readPricing, writePricing } from "./pricing-store.ts";
import type {
	CalendarEntry,
	PricingPlan,
	PricingRule,
	PricingSchema,
	PriceEntity,
} from "./pricing-types.ts";

/** 保存结果：ok=false 时 reason 说明拒绝原因（不落盘） */
export interface SaveResult {
	ok: boolean;
	reason: string;
}

/**
 * 编辑会话：持有 schema 的深拷贝 + 变更记账。
 * 所有 mutate* 方法只改内存；save() 才写盘；reset() 从磁盘重读。
 */
export class PricingDraft {
	/** 内存态（深拷贝，与磁盘解耦） */
	private data: PricingSchema;

	/** 自初始加载以来发生变更的路径集合（"模型/价格/方案/日历/规则"） */
	private changed = new Set<string>();

	constructor(private readonly filePath?: string) {
		this.data = this.load();
	}

	/** 从磁盘读入并深拷贝（避免与 readPricing 返回值共享引用） */
	private load(): PricingSchema {
		return JSON.parse(JSON.stringify(readPricing(this.filePath))) as PricingSchema;
	}

	/** 当前内存态（只读用途：渲染） */
	snapshot(): PricingSchema {
		return this.data;
	}

	/** 是否有未保存改动 */
	get isDirty(): boolean {
		return this.changed.size > 0;
	}

	/** 未保存改动涉及的面（状态栏展示） */
	get changedAreas(): string[] {
		return [...this.changed];
	}

	/** 记录一次变更 */
	private mark(area: string): void {
		this.changed.add(area);
	}

	// ── 模型绑定 ──────────────────────────────────────────────────────────

	/** 切换绑定启用态（软停用，不删除） */
	toggleBinding(provider: string, model: string, planId: string): boolean {
		const conf = this.data.providers[provider]?.models[model];
		if (!conf) return false;
		const binding = conf.plans.find((b) => b.plan === planId);
		if (!binding) return false;
		binding.enabled = !binding.enabled;
		this.mark("模型");
		return true;
	}

	/** 追加绑定到末尾（数组顺序 = 优先级，末尾最低）；已存在则仅启用 */
	addBinding(provider: string, model: string, planId: string): boolean {
		const conf = this.data.providers[provider]?.models[model];
		if (!conf || !this.data.plans[planId]) return false;
		const existing = conf.plans.find((b) => b.plan === planId);
		if (existing) {
			if (existing.enabled) return false;
			existing.enabled = true;
		} else {
			conf.plans.push({ plan: planId, enabled: true });
		}
		this.mark("模型");
		return true;
	}

	/** 解除绑定（原子替换数组，保持顺序不变） */
	removeBinding(provider: string, model: string, planId: string): boolean {
		const conf = this.data.providers[provider]?.models[model];
		if (!conf) return false;
		const before = conf.plans.length;
		conf.plans = conf.plans.filter((b) => b.plan !== planId);
		if (conf.plans.length === before) return false;
		this.mark("模型");
		return true;
	}

	/** 设置模型别名（空字符串 = 清除别名） */
	setAlias(provider: string, model: string, alias: string): boolean {
		const conf = this.data.providers[provider]?.models[model];
		if (!conf) return false;
		if (alias.trim() === "") delete conf.alias;
		else conf.alias = alias.trim();
		this.mark("模型");
		return true;
	}

	// ── 价格实体 ──────────────────────────────────────────────────────────

	/** 修改价格实体字段（input.miss / input.hit / output） */
	setPriceField(priceId: string, field: "input.miss" | "input.hit" | "output", value: number): boolean {
		const p = this.data.prices[priceId];
		if (!p) return false;
		switch (field) {
			case "input.miss": p.input.miss = value; break;
			case "input.hit": p.input.hit = value; break;
			case "output": p.output = value; break;
		}
		this.mark("价格");
		return true;
	}

	/** 新建/覆盖价格实体 */
	upsertPrice(priceId: string, entity: PriceEntity): boolean {
		if (!priceId) return false;
		this.data.prices[priceId] = entity;
		this.mark("价格");
		return true;
	}

	/** 删除价格实体（内存层）；save() 会再做一次引用校验 */
	deletePrice(priceId: string): boolean {
		if (!this.data.prices[priceId]) return false;
		delete this.data.prices[priceId];
		this.mark("价格");
		return true;
	}

	// ── 方案 ──────────────────────────────────────────────────────────────

	/** 新建/覆盖方案 */
	upsertPlan(planId: string, plan: PricingPlan): boolean {
		if (!planId) return false;
		this.data.plans[planId] = plan;
		this.mark("方案");
		return true;
	}

	/** 复制方案（新 id = <src>-copy，重名自动加序号） */
	duplicatePlan(planId: string): string | null {
		const plan = this.data.plans[planId];
		if (!plan) return null;
		let newId = `${planId}-copy`;
		let n = 2;
		while (this.data.plans[newId]) {
			newId = `${planId}-copy${n}`;
			n += 1;
		}
		this.data.plans[newId] = JSON.parse(JSON.stringify({ ...plan, name: `${plan.name}（副本）` })) as PricingPlan;
		this.mark("方案");
		return newId;
	}

	/** 删除方案（内存层）；save() 会再做一次引用校验 */
	deletePlan(planId: string): boolean {
		if (!this.data.plans[planId]) return false;
		delete this.data.plans[planId];
		this.mark("方案");
		return true;
	}

	/** 修改规则的价格引用 */
	setRulePrice(planId: string, ruleIndex: number, priceId: string): boolean {
		const rule = this.data.plans[planId]?.rules[ruleIndex];
		if (!rule || !this.data.prices[priceId]) return false;
		rule.price = priceId;
		this.mark("方案");
		return true;
	}

	/** 设置规则有效期（"" = 清除） */
	setRuleValidUntil(planId: string, ruleIndex: number, validUntil: string): boolean {
		const rule = this.data.plans[planId]?.rules[ruleIndex];
		if (!rule) return false;
		if (validUntil.trim() === "") delete rule.validUntil;
		else rule.validUntil = validUntil.trim();
		this.mark("方案");
		return true;
	}

	/** 追加规则（复制最后一条的形状，避免用户从零填 schedule） */
	addRule(planId: string): boolean {
		const plan = this.data.plans[planId];
		if (!plan) return false;
		const template: PricingRule = plan.rules[plan.rules.length - 1]
			? JSON.parse(JSON.stringify(plan.rules[plan.rules.length - 1])) as PricingRule
			: { schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: Object.keys(this.data.prices)[0] ?? "" };
		plan.rules.push(template);
		this.mark("方案");
		return true;
	}

	/** 删除规则（至少保留一条，避免方案变成空壳） */
	removeRule(planId: string, ruleIndex: number): boolean {
		const plan = this.data.plans[planId];
		if (!plan || plan.rules.length <= 1) return false;
		if (ruleIndex < 0 || ruleIndex >= plan.rules.length) return false;
		plan.rules.splice(ruleIndex, 1);
		this.mark("方案");
		return true;
	}

	// ── 日历 ──────────────────────────────────────────────────────────────

	/** 新建/覆盖日历 */
	upsertCalendar(calId: string, entry: CalendarEntry): boolean {
		if (!calId) return false;
		this.data.calendars[calId] = entry;
		this.mark("日历");
		return true;
	}

	/** 删除日历（内存层）；save() 会校验是否被规则引用 */
	deleteCalendar(calId: string): boolean {
		if (!this.data.calendars[calId]) return false;
		delete this.data.calendars[calId];
		this.mark("日历");
		return true;
	}

	// ── 提交 / 放弃 ───────────────────────────────────────────────────────

	/**
	 * 保存前引用完整性校验：绑定/规则的引用目标必须存在于注册表。
	 * 注意："方案被绑定"本身是合法状态，不在此拒绝；
	 * 只有引用目标缺失（脏引用）或方案无规则才拒绝落盘。
	 * 返回 "" 表示通过，否则返回拒绝原因。
	 */
	private validate(): SaveResult {
		const bindingIssue = this.checkBindings();
		if (bindingIssue) return { ok: false, reason: bindingIssue };
		const planIssue = this.checkPlans();
		if (planIssue) return { ok: false, reason: planIssue };
		return { ok: true, reason: "" };
	}

	/** 校验所有模型绑定都指向存在的方案 */
	private checkBindings(): string {
		for (const [provId, prov] of Object.entries(this.data.providers)) {
			for (const [modelId, conf] of Object.entries(prov.models)) {
				for (const b of conf.plans) {
					if (!this.data.plans[b.plan]) {
						return `模型 ${provId}/${modelId} 绑定了不存在的方案 "${b.plan}"`;
					}
				}
			}
		}
		return "";
	}

	/** 校验每个方案的规则：至少一条、价格引用存在、日历引用存在 */
	private checkPlans(): string {
		for (const [planId, plan] of Object.entries(this.data.plans)) {
			if (plan.rules.length === 0) return `方案 "${planId}" 没有规则`;
			const issue = this.checkRulesOf(planId, plan.rules);
			if (issue) return issue;
		}
		return "";
	}

	/** 校验单个方案的规则引用（价格 / 日历） */
	private checkRulesOf(planId: string, rules: PricingRule[]): string {
		for (const rule of rules) {
			if (!this.data.prices[rule.price]) {
				return `方案 "${planId}" 的规则引用了不存在的价格 "${rule.price}"`;
			}
			const calId = rule.schedule.calendar;
			if (calId && !this.data.calendars[calId]) {
				return `方案 "${planId}" 引用了不存在的日历 "${calId}"`;
			}
		}
		return "";
	}

	/** 全量落盘（用户选择"全量写回"语义）；校验失败则不写 */
	save(): SaveResult {
		const check = this.validate();
		if (!check.ok) return check;
		writePricing(this.data, this.filePath);
		this.changed.clear();
		return { ok: true, reason: "" };
	}

	/** 丢弃所有未保存改动（从磁盘重读） */
	reset(): void {
		this.data = this.load();
		this.changed.clear();
	}
}

