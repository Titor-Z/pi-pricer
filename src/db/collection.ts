/**
 * Collection：document 数组的最小 Mongo 模拟（单集合 CRUD + 唯一 name）。
 *
 * 职责边界：
 * - 只管**单表**结构与增删改查；跨表引用校验、删除保护在 validate.ts。
 * - 不自持文件 IO；写盘由 Database 调 toArray() 全量落盘。
 * - 不依赖 TUI / store，可独立单测。
 *
 * 索引策略：维护 Map<_id, index>；deleteOne 后整体重建（数据量小，简单优于聪明）。
 */

import { UniqueNameError } from "./errors.ts";
import { newDocument, touchDocument, type Document } from "./document.ts";

/** 集合内文档的业务字段类型（去掉公共字段） */
export type DocumentFields<T extends Document> = Omit<T, "_id" | "createdAt" | "updatedAt">;

/** 更新补丁类型：禁止改 _id；createdAt 在实现层忽略 */
export type DocumentPatch<T extends Document> = Partial<Omit<T, "_id">>;

/** 单集合：以数组为存储，_id 索引加速查找 */
export class Collection<T extends Document> {
	/** 内存态文档数组（声明顺序 = 插入顺序） */
	private docs: T[];

	/** _id → 数组下标 的索引（删改后重建） */
	private index = new Map<string, number>();

	constructor(readonly name: string, docs: T[] = []) {
		this.docs = docs;
		this.rebuildIndex();
	}

	/** 重建 _id 索引（构造与删除后调用） */
	private rebuildIndex(): void {
		this.index = new Map(this.docs.map((doc, i) => [doc._id, i]));
	}

	// ── 读 ────────────────────────────────────────────────────────────────

	/** 全部文档（只读视图，保持插入顺序） */
	all(): readonly T[] {
		return this.docs;
	}

	/** 按 _id 取文档（O(1)） */
	findById(id: string): T | undefined {
		const i = this.index.get(id);
		return i === undefined ? undefined : this.docs[i];
	}

	/** 取第一条满足条件的文档 */
	findOne(predicate: (doc: T) => boolean): T | undefined {
		return this.docs.find(predicate);
	}

	/** 取全部满足条件的文档（保持顺序） */
	find(predicate: (doc: T) => boolean): T[] {
		return this.docs.filter(predicate);
	}

	/** 文档数量 */
	count(): number {
		return this.docs.length;
	}

	// ── 写 ────────────────────────────────────────────────────────────────

	/** 新增文档：注入 _id 与 createdAt，追加到末尾 */
	insertOne(fields: DocumentFields<T>): T {
		const doc = newDocument<T>(fields);
		this.docs.push(doc);
		this.index.set(doc._id, this.docs.length - 1);
		return doc;
	}

	/**
	 * 按 _id 更新：合并 patch 并刷新 updatedAt。
	 * 显式忽略 patch 中的 createdAt（创建时间不可篡改）；_id 已由类型挡住。
	 */
	updateOne(id: string, patch: DocumentPatch<T>): T | undefined {
		const doc = this.findById(id);
		if (!doc) return undefined;
		const { createdAt: _ignored, ...rest } = patch as Record<string, unknown>;
		Object.assign(doc, rest);
		return touchDocument(doc);
	}

	/** 按 _id 删除；返回是否删到 */
	deleteOne(id: string): boolean {
		const i = this.index.get(id);
		if (i === undefined) return false;
		this.docs.splice(i, 1);
		this.rebuildIndex();
		return true;
	}

	// ── 唯一性 ────────────────────────────────────────────────────────────

	/**
	 * 校验某字段值在本集合内唯一；冲突抛 UniqueNameError。
	 * excludeId：更新自身时传入，允许"值没变"。
	 */
	ensureUnique(key: keyof T & string, value: unknown, excludeId?: string): void {
		const hit = this.findOne((d) => (d as Record<string, unknown>)[key] === value);
		if (hit && hit._id !== excludeId) {
			throw new UniqueNameError(this.name, String(value), hit._id);
		}
	}

	/** 校验 name 唯一（rates/calendars/rules/plans 用；models 用 ensureUnique 校验二元键） */
	ensureUniqueName(name: string, excludeId?: string): void {
		this.ensureUnique("name" as keyof T & string, name, excludeId);
	}

	// ── 序列化 ────────────────────────────────────────────────────────────

	/** 深拷贝全部文档（供 Database 落盘；防止外部改动内存态） */
	toArray(): T[] {
		return structuredClone(this.docs);
	}

	/** 用外部数据替换全部文档（供 Database.reload） */
	load(docs: T[]): void {
		this.docs = docs;
		this.rebuildIndex();
	}
}
