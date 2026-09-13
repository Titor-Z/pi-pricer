/**
 * AI 辅助配置服务层：把语义动作落到 Database 事务上，并提供草稿视图。
 *
 * 会话模型（整批原子）：
 * - applyActions(actions)：在**一个长期事务**上依次执行；任一动作失败 → 整批回滚，不做部分提交
 * - diffPreview()：对比"已提交内存态"与"事务工作副本"，给出人类可读改动预览
 * - commit()：走 pi 的文件队列 + 校验 + 乐观锁，一次性原子落盘
 * - discard()：丢弃事务，回到磁盘态
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Database, type SaveResult, type Transaction } from "./db/database.ts";
import {
	checkCalendarDeletable,
	checkPlanDeletable,
	checkRateDeletable,
	checkRuleDeletable,
} from "./db/validate.ts";
import type { PricingAction } from "./pricing-agent-actions.ts";
import type { CollectionName, PricingSchema } from "./pricing-types.ts";

/** 单个动作的执行失败信息（整批回滚时返回） */
export interface ActionFailure {
	/** 失败动作的 kind */
	kind: string;
	/** 失败原因（中文） */
	reason: string;
}

/** 批量动作结果 */
export interface ApplyResult {
	/** 是否全部成功（成功即已进入事务工作副本，尚未落盘） */
	ok: boolean;
	/** 失败明细（ok=true 时为空数组） */
	failures: ActionFailure[];
}

/**
 * 把单个动作作用到事务工作副本上；失败抛 Error（由调用方汇总并整批回滚）。
 * 引用一律按 name 解析（LLM 无需知道 _id）。
 */
export function applyAction(tx: Transaction, action: PricingAction): void {
	switch (action.kind) {
		case "upsertRate": {
			const existing = tx.rates.findOne((r) => r.name === action.name);
			if (existing) {
				tx.rates.updateOne(existing._id, { inputMiss: action.inputMiss, inputHit: action.inputHit, output: action.output });
			} else {
				tx.rates.insertOne({ name: action.name, inputMiss: action.inputMiss, inputHit: action.inputHit, output: action.output });
			}
			return;
		}
		case "deleteRate": {
			const schema = tx.snapshot();
			const rate = schema.rates.find((r) => r.name === action.name);
			if (!rate) throw new Error(`价格「${action.name}」不存在`);
			const check = checkRateDeletable(schema, rate._id);
			if (!check.ok) throw new Error(check.reason);
			tx.rates.deleteOne(rate._id);
			return;
		}
		case "upsertCalendar": {
			const existing = tx.calendars.findOne((c) => c.name === action.name);
			const fields = { name: action.name, dates: action.dates, ...(action.region ? { region: action.region } : {}) };
			if (existing) tx.calendars.updateOne(existing._id, fields);
			else tx.calendars.insertOne(fields);
			return;
		}
		case "addCalendarDates": {
			const cal = tx.calendars.findOne((c) => c.name === action.name);
			if (!cal) throw new Error(`日历「${action.name}」不存在`);
			tx.calendars.updateOne(cal._id, { dates: [...new Set([...cal.dates, ...action.dates])] });
			return;
		}
		case "deleteCalendar": {
			const schema = tx.snapshot();
			const cal = schema.calendars.find((c) => c.name === action.name);
			if (!cal) throw new Error(`日历「${action.name}」不存在`);
			const check = checkCalendarDeletable(schema, cal._id);
			if (!check.ok) throw new Error(check.reason);
			tx.calendars.deleteOne(cal._id);
			return;
		}
		case "upsertRule": {
			const schema = tx.snapshot();
			const rate = schema.rates.find((r) => r.name === action.rateName);
			if (!rate) throw new Error(`引用的价格「${action.rateName}」不存在，请先创建`);
			const toIds = (names: string[] | undefined, kind: "日历"): string[] =>
				(names ?? []).map((name) => {
					const cal = schema.calendars.find((c) => c.name === name);
					if (!cal) throw new Error(`引用的${kind}「${name}」不存在，请先创建`);
					return cal._id;
				});
			const fields = {
				name: action.name,
				rateId: rate._id,
				timezone: action.timezone ?? "Asia/Shanghai",
				weekdays: action.weekdays ?? [],
				ranges: action.ranges ?? [],
				includeCalendars: toIds(action.includeCalendars, "日历"),
				excludeCalendars: toIds(action.excludeCalendars, "日历"),
				includeDates: action.includeDates ?? [],
				excludeDates: action.excludeDates ?? [],
				...(action.validUntil ? { validUntil: action.validUntil } : {}),
			};
			const existing = schema.rules.find((r) => r.name === action.name);
			if (existing) tx.rules.updateOne(existing._id, fields);
			else tx.rules.insertOne(fields);
			return;
		}
		case "deleteRule": {
			const schema = tx.snapshot();
			const rule = schema.rules.find((r) => r.name === action.name);
			if (!rule) throw new Error(`规则「${action.name}」不存在`);
			const check = checkRuleDeletable(schema, rule._id);
			if (!check.ok) throw new Error(check.reason);
			tx.rules.deleteOne(rule._id);
			return;
		}
		case "upsertPlan": {
			const schema = tx.snapshot();
			const ruleIds = (action.ruleNames ?? []).map((name) => {
				const rule = schema.rules.find((r) => r.name === name);
				if (!rule) throw new Error(`引用的规则「${name}」不存在，请先创建`);
				return rule._id;
			});
			const existing = schema.plans.find((p) => p.name === action.name);
			const fields = {
				name: action.name,
				enabled: action.enabled ?? true,
				ruleIds: action.ruleNames === undefined && existing ? existing.ruleIds : ruleIds,
				...(action.alias ? { alias: action.alias } : {}),
			};
			if (existing) tx.plans.updateOne(existing._id, fields);
			else tx.plans.insertOne(fields);
			return;
		}
		case "setPlanEnabled": {
			const plan = tx.plans.findOne((p) => p.name === action.name);
			if (!plan) throw new Error(`方案「${action.name}」不存在`);
			tx.plans.updateOne(plan._id, { enabled: action.enabled });
			return;
		}
		case "deletePlan": {
			const schema = tx.snapshot();
			const plan = schema.plans.find((p) => p.name === action.name);
			if (!plan) throw new Error(`方案「${action.name}」不存在`);
			const check = checkPlanDeletable(schema, plan._id);
			if (!check.ok) throw new Error(check.reason);
			tx.plans.deleteOne(plan._id);
			return;
		}
		case "bindModel": {
			const plan = tx.plans.findOne((p) => p.name === action.planName);
			if (!plan) throw new Error(`方案「${action.planName}」不存在`);
			const existing = tx.models.findOne((m) => m.provider === action.provider && m.model === action.model);
			if (existing) tx.models.updateOne(existing._id, { planId: plan._id });
			else tx.models.insertOne({ provider: action.provider, model: action.model, planId: plan._id });
			return;
		}
		case "unbindModel": {
			const model = tx.models.findOne((m) => m.provider === action.provider && m.model === action.model);
			if (!model) throw new Error(`模型 ${action.provider}/${action.model} 未绑定任何方案`);
			tx.models.deleteOne(model._id);
			return;
		}
		default: {
			// 穷尽性检查：新增 kind 若漏分发，此处编译期报错
			const never: never = action;
			throw new Error(`未知动作：${JSON.stringify(never)}`);
		}
	}
}

/** 各集合的展示名与人类标签（diff 用） */
const COLLECTION_LABELS: Array<{ key: CollectionName; label: string }> = [
	{ key: "rates", label: "价格" },
	{ key: "calendars", label: "日历" },
	{ key: "rules", label: "规则" },
	{ key: "plans", label: "方案" },
	{ key: "models", label: "模型" },
];

/** 文档的展示名（models 用 provider/model，其余用 name） */
function documentLabel(doc: Record<string, unknown>): string {
	if (typeof doc.name === "string") return doc.name;
	if (typeof doc.provider === "string" && typeof doc.model === "string") return `${doc.provider}/${doc.model}`;
	return String(doc._id);
}

/**
 * 对比两份 schema，返回人类可读的改动预览。
 * 同一集合内按 _id 判定 新增 / 删除 / 修改。
 */
export function diffSchemas(before: PricingSchema, after: PricingSchema): string {
	const lines: string[] = [];
	for (const { key, label } of COLLECTION_LABELS) {
		const beforeDocs = before[key] as unknown as Array<Record<string, unknown>>;
		const afterDocs = after[key] as unknown as Array<Record<string, unknown>>;
		const beforeMap = new Map(beforeDocs.map((d) => [String(d._id), d]));
		const afterMap = new Map(afterDocs.map((d) => [String(d._id), d]));
		const added = afterDocs.filter((d) => !beforeMap.has(String(d._id)));
		const removed = beforeDocs.filter((d) => !afterMap.has(String(d._id)));
		const changed = afterDocs.filter((d) => {
			const prev = beforeMap.get(String(d._id));
			return prev !== undefined && JSON.stringify(prev) !== JSON.stringify(d);
		});
		for (const doc of added) lines.push(`＋ ${label}：${documentLabel(doc)}`);
		for (const doc of removed) lines.push(`－ ${label}：${documentLabel(doc)}`);
		for (const doc of changed) lines.push(`～ ${label}：${documentLabel(doc)}`);
	}
	return lines.length > 0 ? lines.join("\n") : "（无改动）";
}

/** 现状摘要（供 price_get） */
export function describeSchema(schema: PricingSchema): string {
	const names = (docs: Array<{ name: string }>): string => (docs.length > 0 ? docs.map((d) => d.name).join("、") : "（空）");
	const models = schema.models.map((m) => `${m.provider}/${m.model}`).join("、");
	return [
		`价格表（${schema.rates.length}）：${names(schema.rates)}`,
		`日历表（${schema.calendars.length}）：${names(schema.calendars)}`,
		`规则表（${schema.rules.length}）：${names(schema.rules)}`,
		`方案表（${schema.plans.length}）：${names(schema.plans)}`,
		`模型绑定（${schema.models.length}）：${models || "（空）"}`,
	].join("\n");
}

/** AI 辅助配置服务：持有长期事务作为草稿 */
export class PricingAgentService {
	/** 已打开的数据库（惰性） */
	private database: Database | null = null;
	/** 当前草稿事务（null = 无未保存改动） */
	private draft: Transaction | null = null;

	constructor(private readonly filePath?: string) {}

	/** 取数据库（惰性打开，保持乐观锁基线一致） */
	private db(): Database {
		if (!this.database) this.database = Database.open(this.filePath);
		return this.database;
	}

	/** 是否有未保存改动 */
	get hasPending(): boolean {
		return this.draft !== null;
	}

	/** 现状摘要 */
	getSummary(): string {
		return describeSchema(this.db().snapshot());
	}

	/**
	 * 应用一组动作（整批原子）：
	 * 任一动作失败 → 丢弃本批全部改动（含此前未提交的草稿），返回失败明细。
	 */
	applyActions(actions: PricingAction[]): ApplyResult {
		const failures: ActionFailure[] = [];
		const tx = this.draft ?? (this.draft = this.db().begin());
		for (const action of actions) {
			try {
				applyAction(tx, action);
			} catch (error) {
				failures.push({ kind: action.kind, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		if (failures.length > 0) {
			// 整批原子：回滚包括之前累积的草稿，避免留下"成功一半"的状态
			tx.rollback();
			this.draft = null;
			return {
				ok: false,
				failures: [
					...failures,
					{ kind: "batch", reason: "本批动作未生效：任一动作失败即整批回滚，请修正后重试" },
				],
			};
		}
		return { ok: true, failures: [] };
	}

	/** 未保存改动的可读预览 */
	diffPreview(): string {
		if (!this.draft) return "（无未保存改动）";
		return diffSchemas(this.db().snapshot(), this.draft.snapshot());
	}

	/** 落盘：经 pi 文件队列 + 校验 + 乐观锁，一次性原子写 */
	async commit(): Promise<SaveResult> {
		if (!this.draft) return { ok: false, reason: "没有待保存的改动" };
		const tx = this.draft;
		const result = await withFileMutationQueue(this.db().filePath, async () => tx.commit());
		if (result.ok) this.draft = null;
		return result;
	}

	/** 丢弃草稿（回到磁盘态） */
	discard(): void {
		if (this.draft) this.draft.rollback();
		this.draft = null;
		this.database = null; // 下次访问重新读盘，保证与磁盘一致
	}
}
