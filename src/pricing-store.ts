/**
 * JSON 存储层（薄 IO）：读写 ~/.pi/model-pricing.json。
 *
 * 职责边界：
 * - 只负责"读文件 / 写文件 / 首次播种"，不做校验与跨表引用（那在 validate.ts / database.ts）。
 * - v5 为唯一当前格式：文件缺失、JSON 损坏、或 version ≠ 5 → 返回 v5 种子（内存），
 *   **不主动改写磁盘上的旧文件**，等用户实际保存时再覆盖。
 * - 写入为原子操作：先写同目录临时文件，再 rename 覆盖，避免中途崩溃留下截断 JSON。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PricingSchema } from "./pricing-types.ts";
import { DEFAULT_PRICING } from "./pricing-defaults.ts";

/** 默认文件路径（~/.pi/model-pricing.json） */
export const DEFAULT_PRICING_PATH = join(homedir(), ".pi", "model-pricing.json");

/** 深拷贝内置种子（避免调用方就地修改 DEFAULT_PRICING 常量） */
function cloneDefaults(): PricingSchema {
	return structuredClone(DEFAULT_PRICING);
}

/** 判断解析出的数据是否为 v5 根结构（最简校验，深校验交给 validate.ts） */
function isV5(data: unknown): data is PricingSchema {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (obj.version !== 5) return false;
	for (const key of ["rates", "calendars", "rules", "plans", "models"]) {
		if (!Array.isArray(obj[key])) return false;
	}
	return true;
}

/**
 * 读取配置：文件缺失 / 损坏 / 非 v5 → 返回 v5 种子（深拷贝）。
 * 不修改磁盘；旧文件在新格式保存前保持原样。
 */
export function readPricing(filePath: string = DEFAULT_PRICING_PATH): PricingSchema {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return cloneDefaults();
	}
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return cloneDefaults();
	}
	return isV5(data) ? data : cloneDefaults();
}

/** 写入配置（创建目录 + 原子写：临时文件 → rename） */
export function writePricing(schema: PricingSchema, filePath: string = DEFAULT_PRICING_PATH): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(schema, null, "\t") + "\n", "utf8");
	renameSync(tmpPath, filePath);
}

/** 首次播种：仅当文件不存在时写入 v5 种子；已存在（含旧版本）不动 */
export function seedPricing(filePath: string = DEFAULT_PRICING_PATH): void {
	if (!existsSync(filePath)) writePricing(cloneDefaults(), filePath);
}
