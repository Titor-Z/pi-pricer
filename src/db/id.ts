/**
 * 文档 id 生成与校验：16 位小写十六进制字符串。
 *
 * 形态：4B 秒级时间戳(8 hex) + 2B 随机(4 hex) + 2B 自增计数(4 hex) = 16 hex。
 * 为什么不用 MongoDB 的 24 位 ObjectId：本项目按需选用更短的 16 位十六进制，
 * 保持"数字字母混合、看起来随机"的数据库 id 观感，同时长度更短。
 *
 * id 不承担可读性（可读性由各表唯一 name 负责）；跨表引用一律用它。
 */

/** 进程内自增计数器（低 2 字节），降低同秒多次生成的撞号概率 */
let counter = Math.floor(Math.random() * 0xffff);

/** 生成 16 位小写十六进制 id（时间戳 + 随机 + 自增） */
export function generateId(): string {
	const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
	const random = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
	counter = (counter + 1) % 0xffff;
	const inc = counter.toString(16).padStart(4, "0");
	return `${timestamp}${random}${inc}`;
}

/** 校验是否为合法 id 形态（16 位小写十六进制） */
export function isValidId(value: string): boolean {
	return /^[0-9a-f]{16}$/.test(value);
}

/** 从 id 反解创建时间戳（毫秒）；非法 id 返回 0（排序兜底用） */
export function idTimestamp(id: string): number {
	if (!isValidId(id)) return 0;
	return parseInt(id.slice(0, 8), 16) * 1000;
}
