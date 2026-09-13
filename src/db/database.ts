/**
 * Database：五个集合的组装 + 事务化提交（对齐 MySQL 的事务语义）。
 *
 * 事务模型（单文件天然支持原子提交）：
 * - transaction(fn)：在**工作副本**上执行 fn → 全量校验 → 一次性原子写盘 → 换入内存
 * - fn 抛错 / 校验失败 / 乐观锁冲突 → 丢弃工作副本（回滚），磁盘不变
 * - 乐观锁：提交前比对文件内容哈希，与加载时不一致（被外部修改）则拒绝，防丢更新
 *
 * 读取路径（findModel / explainPlan）直接走当前内存态（已提交状态）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
	CalendarDoc,
	ModelDoc,
	PlanDoc,
	PricingSchema,
	RateDoc,
	RuleDoc,
} from "../pricing-types.ts";
import { Collection } from "./collection.ts";
import { ConcurrencyError, ValidationError } from "./errors.ts";
import { validateSchema } from "./validate.ts";
import { DEFAULT_PRICING_PATH, readPricing, writePricing } from "../pricing-store.ts";

/** 提交结果 */
export interface SaveResult {
	/** 是否成功落盘 */
	ok: boolean;
	/** 失败原因（ok=true 时为空串） */
	reason: string;
}

/** 文件内容哈希（用于乐观锁比对）；文件不存在返回 null */
function hashFile(filePath: string): string | null {
	try {
		return createHash("sha256").update(readFileSync(filePath, "utf8")).digest("hex");
	} catch {
		return null;
	}
}

/**
 * 事务：持有五张表的工作副本。
 * 提交后工作副本被丢弃，改动并入 Database 的内存态。
 */
export class Transaction {
	readonly rates: Collection<RateDoc>;
	readonly calendars: Collection<CalendarDoc>;
	readonly rules: Collection<RuleDoc>;
	readonly plans: Collection<PlanDoc>;
	readonly models: Collection<ModelDoc>;

	/** 事务发起方（提交成功后把工作副本并入其内存态） */
	private readonly owner: Database;
	/** 提交状态：已提交或已回滚后不可再用 */
	private settled = false;

	constructor(owner: Database, schema: PricingSchema) {
		this.owner = owner;
		this.rates = new Collection<RateDoc>("rates", structuredClone(schema.rates));
		this.calendars = new Collection<CalendarDoc>("calendars", structuredClone(schema.calendars));
		this.rules = new Collection<RuleDoc>("rules", structuredClone(schema.rules));
		this.plans = new Collection<PlanDoc>("plans", structuredClone(schema.plans));
		this.models = new Collection<ModelDoc>("models", structuredClone(schema.models));
	}

	/** 把工作副本导出为完整 schema */
	toSchema(): PricingSchema {
		return {
			version: 5,
			rates: this.rates.toArray(),
			calendars: this.calendars.toArray(),
			rules: this.rules.toArray(),
			plans: this.plans.toArray(),
			models: this.models.toArray(),
		};
	}

	/** 当前工作副本快照（与 toSchema 同义，命名便于调用方阅读） */
	snapshot(): PricingSchema {
		return this.toSchema();
	}

	/**
	 * 提交：校验 → 乐观锁 → 原子写 → 并入内存态。
	 * 失败返回 {ok:false, reason}，不抛异常；调用方决定报错方式。
	 */
	commit(): SaveResult {
		if (this.settled) return { ok: false, reason: "事务已结束，不能重复提交" };
		const schema = this.toSchema();
		const issues = validateSchema(schema);
		if (issues.length > 0) return { ok: false, reason: issues.join("；") };
		const conflict = this.owner.checkConcurrency();
		if (conflict) return { ok: false, reason: conflict };
		writePricing(schema, this.owner.filePath);
		this.owner.adopt(schema);
		this.settled = true;
		return { ok: true, reason: "" };
	}

	/** 回滚：丢弃工作副本（无需操作，GC 回收） */
	rollback(): void {
		this.settled = true;
	}
}

/** 数据库：持有当前已提交状态，提供读视图与事务入口 */
export class Database {
	/** 当前内存态（已提交）五张表 */
	readonly rates: Collection<RateDoc>;
	readonly calendars: Collection<CalendarDoc>;
	readonly rules: Collection<RuleDoc>;
	readonly plans: Collection<PlanDoc>;
	readonly models: Collection<ModelDoc>;

	/** 加载时的文件内容哈希（null = 加载时文件不存在）；乐观锁用 */
	private revision: string | null;

	private constructor(readonly filePath: string, schema: PricingSchema, revision: string | null) {
		this.rates = new Collection<RateDoc>("rates", schema.rates);
		this.calendars = new Collection<CalendarDoc>("calendars", schema.calendars);
		this.rules = new Collection<RuleDoc>("rules", schema.rules);
		this.plans = new Collection<PlanDoc>("plans", schema.plans);
		this.models = new Collection<ModelDoc>("models", schema.models);
		this.revision = revision;
	}

	/** 打开数据库：读文件（缺失/损坏/旧版本 → v5 种子），记录 revision */
	static open(filePath: string = DEFAULT_PRICING_PATH): Database {
		return new Database(filePath, readPricing(filePath), hashFile(filePath));
	}

	/** 当前内存态快照（深拷贝） */
	snapshot(): PricingSchema {
		return {
			version: 5,
			rates: this.rates.toArray(),
			calendars: this.calendars.toArray(),
			rules: this.rules.toArray(),
			plans: this.plans.toArray(),
			models: this.models.toArray(),
		};
	}

	/** 乐观锁检查：返回冲突原因，或 null 表示无冲突 */
	checkConcurrency(): string | null {
		const current = hashFile(this.filePath);
		if (current === this.revision) return null;
		return `配置文件在加载后被外部修改，提交被拒绝（可能丢失他人改动）：${this.filePath}`;
	}

	/** 提交后并入新状态（内部使用） */
	adopt(schema: PricingSchema): void {
		this.rates.load(structuredClone(schema.rates));
		this.calendars.load(structuredClone(schema.calendars));
		this.rules.load(structuredClone(schema.rules));
		this.plans.load(structuredClone(schema.plans));
		this.models.load(structuredClone(schema.models));
		this.revision = hashFile(this.filePath);
	}

	/** 从磁盘重新加载（丢弃内存态；乐观锁基线一并刷新） */
	reload(): void {
		const fresh = readPricing(this.filePath);
		this.adopt(fresh);
	}

	/**
	 * 开启一个可长期持有的事务（AI 草稿用）：多次改动后一次性 commit。
	 * 与 transaction() 的区别：不自动提交，由调用方决定 commit / rollback。
	 */
	begin(): Transaction {
		return new Transaction(this, this.snapshot());
	}

	/**
	 * 事务入口：在工作副本上执行 fn，然后提交。
	 * - fn 抛错 → 回滚并原样抛出
	 * - 校验失败 / 乐观锁冲突 → 回滚并抛 ValidationError / ConcurrencyError
	 */
	transaction<T>(fn: (tx: Transaction) => T): T {
		const tx = new Transaction(this, this.snapshot());
		let value: T;
		try {
			value = fn(tx);
		} catch (error) {
			tx.rollback();
			throw error;
		}
		const result = tx.commit();
		if (!result.ok) {
			tx.rollback();
			throw this.toCommitError(result.reason);
		}
		return value;
	}

	/** 便捷保存：单事务空操作提交（用于直接写入既有内存态） */
	save(): SaveResult {
		const tx = new Transaction(this, this.snapshot());
		return tx.commit();
	}

	/** 把提交失败原因转成合适的具体错误类型 */
	private toCommitError(reason: string): Error {
		return this.checkConcurrency() ? new ConcurrencyError(this.filePath) : new ValidationError([reason]);
	}

	// ── 跨表 join 读取 ────────────────────────────────────────────────────

	/** 按厂商 + 模型名查找模型文档 */
	findModel(provider: string, model: string): ModelDoc | undefined {
		return this.models.findOne((m) => m.provider === provider && m.model === model);
	}

	/** 展开方案的完整信息（plan → rules → rate/calendars），供只读命令与 AI 读取 */
	explainPlan(planId: string): Explanation | undefined {
		const plan = this.plans.findById(planId);
		if (!plan) return undefined;
		const rules = plan.ruleIds
			.map((id) => this.rules.findById(id))
			.filter((r): r is RuleDoc => r !== undefined)
			.map((rule) => ({
				rule,
				rate: this.rates.findById(rule.rateId),
				includeCalendars: rule.includeCalendars
					.map((id) => this.calendars.findById(id))
					.filter((c): c is CalendarDoc => c !== undefined),
				excludeCalendars: rule.excludeCalendars
					.map((id) => this.calendars.findById(id))
					.filter((c): c is CalendarDoc => c !== undefined),
			}));
		return { plan, rules };
	}

	/** 列出绑定了某方案的模型 */
	listModelsByPlan(planId: string): ModelDoc[] {
		return this.models.find((m) => m.planId === planId);
	}
}

/** explainPlan 的返回结构：方案 + 每条规则及其解析出的价格/日历 */
export interface Explanation {
	/** 方案文档 */
	plan: PlanDoc;
	/** 规则及其关联实体 */
	rules: Array<{
		rule: RuleDoc;
		/** 引用到的价格（悬空时为 undefined，正常数据不会） */
		rate?: RateDoc;
		includeCalendars: CalendarDoc[];
		excludeCalendars: CalendarDoc[];
	}>;
}
