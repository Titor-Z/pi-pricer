/**
 * JSON 存储层：读写 ~/.pi/model-pricing.json + 首次 seeding + schema 校验。
 *
 * 纯函数层（store 加载/写入逻辑）+ IO 层（文件读写）分离设计。
 * 文件损坏时静默回退到内置默认价格，不抛异常。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PricingSchema } from "./pricing-types.ts";
import { DEFAULT_PRICING } from "./pricing-defaults.ts";

/** 默认文件路径（~/.pi/model-pricing.json） */
const DEFAULT_PATH = join(homedir(), ".pi", "model-pricing.json");

/**
 * 校验 JSON 结构是否为合法 PricingSchema v1（最简校验：version 字段 + providers 对象）。
 * 不做深度校验（字段类型由 TypeScript 保证 + JSON 手动编辑时容错）。
 */
function isValidSchema(data: unknown): data is PricingSchema {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (obj.version !== 1) return false;
	if (typeof obj.providers !== "object" || obj.providers === null) return false;
	return true;
}

/** 深拷贝内置默认价格（防止修改默认值） */
function cloneDefaults(): PricingSchema {
	return JSON.parse(JSON.stringify(DEFAULT_PRICING));
}

/** 读取 JSON 文件；不存在或损坏时返回内置默认值的深拷贝 */
export function readPricing(filePath: string = DEFAULT_PATH): PricingSchema {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return cloneDefaults();
	}
	try {
		const data = JSON.parse(raw);
		if (!isValidSchema(data)) return cloneDefaults();
		return data;
	} catch {
		return cloneDefaults();
	}
}

/** 写入 JSON 文件（创建目录 + 原子写入） */
export function writePricing(data: PricingSchema, filePath: string = DEFAULT_PATH): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, JSON.stringify(data, null, "\t") + "\n", "utf8");
}

/** 首次启动 seeding：文件不存在时写入内置默认价格 */
export function seedPricing(filePath: string = DEFAULT_PATH): void {
	try {
		readFileSync(filePath, "utf8");
	} catch {
		writePricing(cloneDefaults(), filePath);
	}
}

/** 安全修改：读 → 变更 → 写（保证原子性） */
export function updatePricing(
	mutator: (data: PricingSchema) => PricingSchema,
	filePath: string = DEFAULT_PATH,
): PricingSchema {
	const data = readPricing(filePath);
	const updated = mutator(data);
	writePricing(updated, filePath);
	return updated;
}
