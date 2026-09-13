/**
 * TUI 草稿会话：把"边改边看"与"一次落盘"分开。
 *
 * 设计：
 * - 持有 Database（已提交内存态）+ 一个长期事务（工作副本）
 * - 所有编辑直接改事务的五张表；渲染读工作副本
 * - Ctrl+S → 经 pi 文件队列 + 校验 + 乐观锁，一次原子落盘；成功后重建工作副本
 * - Ctrl+R → 丢弃工作副本并重读磁盘
 * - 脏标记 = 工作副本与已提交态是否一致（JSON 比较，数据量小）
 *
 * 纯逻辑无 TUI 依赖，可独立单测。
 */

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Database, type SaveResult, type Transaction } from "../db/database.ts";
import type { PricingSchema } from "../pricing-types.ts";

/** 草稿会话 */
export class PricingSession {
	/** 数据库（已提交态 + 乐观锁基线） */
	private database: Database;

	/** 工作副本事务（当前编辑态） */
	private work: Transaction;

	/** 最近一次"已提交态"的序列化（用于脏标记比较） */
	private baseline: string;

	constructor(private readonly filePath?: string) {
		this.database = Database.open(filePath);
		this.work = this.database.begin();
		this.baseline = serialize(this.work.snapshot());
	}

	/** 当前工作副本（渲染用）：未保存的编辑都从这里读 */
	get schema(): PricingSchema {
		return this.work.snapshot();
	}

	/** 工作副本事务（页面直接调用其五张表做增删改） */
	get tx(): Transaction {
		return this.work;
	}

	/** 是否有未保存改动 */
	get isDirty(): boolean {
		return serialize(this.work.snapshot()) !== this.baseline;
	}

	/** 落盘：经 pi 文件队列 + 校验 + 乐观锁；成功后重建工作副本 */
	async save(): Promise<SaveResult> {
		if (!this.isDirty) return { ok: true, reason: "" };
		const result = await withFileMutationQueue(this.database.filePath, async () => this.work.commit());
		if (result.ok) {
			this.work = this.database.begin();
			this.baseline = serialize(this.work.snapshot());
		}
		return result;
	}

	/** 丢弃未保存改动：重读磁盘并重建工作副本 */
	reset(): void {
		this.work.rollback();
		this.database.reload();
		this.work = this.database.begin();
		this.baseline = serialize(this.work.snapshot());
	}
}

/** 序列化（键序稳定，保证比较可靠） */
function serialize(schema: PricingSchema): string {
	return JSON.stringify(schema);
}
