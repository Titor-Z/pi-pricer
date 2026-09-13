/**
 * Document 基类型与工厂：v5 所有实体共用的 _id + 时间字段。
 *
 * 时间用毫秒级 ISO 字符串（而非 Mongo 的秒级 ObjectId 内嵌时间）：
 * 规则优先级按"创建时间，后创建覆盖先创建"判定，同秒创建会退化，
 * 故 createdAt 必须保留毫秒精度；_id 仅作同毫秒时的 tie-break。
 */

import { generateId } from "./id.ts";

/** 所有集合文档的公共字段 */
export interface Document {
	/** 唯一标识（16 位十六进制；数字字母混合、不可读） */
	_id: string;
	/** 创建时间（毫秒级 ISO 8601） */
	createdAt: string;
	/** 最近更新时间（毫秒级 ISO 8601）；从未更新则不存在 */
	updatedAt?: string;
}

/** 当前时间的毫秒级 ISO 字符串 */
export function nowIso(): string {
	return new Date().toISOString();
}

/**
 * 由业务字段构造完整文档：注入 _id 与 createdAt。
 * 返回类型为 T（调用方给出含 Document 字段的完整类型）。
 */
export function newDocument<T extends Document>(fields: Omit<T, "_id" | "createdAt" | "updatedAt">): T {
	return { ...fields, _id: generateId(), createdAt: nowIso() } as T;
}

/** 标记文档已更新：刷新 updatedAt（返回同一对象，便于链式使用） */
export function touchDocument<T extends Document>(doc: T): T {
	doc.updatedAt = nowIso();
	return doc;
}

/** 创建时间先后比较：先比 createdAt（毫秒），同毫秒用 _id tie-break */
export function compareDocumentOrder(a: Document, b: Document): number {
	if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
	if (a._id === b._id) return 0;
	return a._id < b._id ? -1 : 1;
}
