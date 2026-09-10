/**
 * JSON 存储层：读写 ~/.pi/model-pricing.json + 首次 seeding + v1/v2 版本识别与迁移。
 *
 * - v2 为当前格式；读到 v1 文件时**内存自动迁移**成 v2（版本内开展示无缝升级）
 * - 文件不存在/损坏时静默回退 v2 内置默认值，不抛异常
 * - 写入前 mkdirSync 防御；原子写入
 * - 提供 plan/price 删除的引用保护（被绑定/被引用时拒绝删除）
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
	PricingSchema,
	PricingSchemaV1,
	PricingSchemaV2,
} from "./pricing-types.ts";
import { DEFAULT_PRICING } from "./pricing-defaults.ts";

/** 默认文件路径（~/.pi/model-pricing.json） */
const DEFAULT_PATH = join(homedir(), ".pi", "model-pricing.json");

/** 校验 v2 根结构（最简校验：version + 四个注册表均为对象） */
function isValidV2(data: unknown): data is PricingSchemaV2 {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	if (obj.version !== 2) return false;
	for (const key of ["calendars", "prices", "plans", "providers"]) {
		if (typeof obj[key] !== "object" || obj[key] === null) return false;
	}
	return true;
}

/** 校验 v1 根结构（version = 1 + providers 对象） */
function isV1(data: unknown): data is PricingSchemaV1 {
	if (typeof data !== "object" || data === null) return false;
	const obj = data as Record<string, unknown>;
	return obj.version === 1 && typeof obj.providers === "object" && obj.providers !== null;
}

/**
 * v1 → v2 迁移：
 * - 每厂商按 peakHours 拆"峰 / 谷"两个方案（+两个价格实体），
 *   峰价输入沿用 v1 谷输入（v1 未存峰输入价），迁移后可手动补 true 峰输入
 * - peakHours 为 null（或无峰价）→ 单"全时标准"方案
 * - 模型绑定其厂商生成的方案；alias 保留
 */
export function migrateV1ToV2(v1: PricingSchemaV1): PricingSchemaV2 {
	const out: PricingSchemaV2 = {
		version: 2,
		calendars: {},
		prices: {},
		plans: {},
		providers: {},
	};

	for (const [providerId, prov] of Object.entries(v1.providers)) {
		const modelIds = Object.keys(prov.models);
		out.providers[providerId] = { models: {} };
		const hasPeak = prov.peakHours !== null && modelIds.some((m) => prov.models[m].output.peak !== null);
		// 形状相同（输入/标准/峰价一致）的模型共用同一价格实体与方案，避免每模型一套
		const peakKeyOf = (m: PricingSchemaV1["providers"][string]["models"][string]) => `${m.input.miss}|${m.input.hit}|${m.output.standard}|${m.output.peak}`;
		const planIds = new Map<string, { peakId?: string; peakPlanId?: string; valleyId: string; valleyPlanId: string }>();

		if (hasPeak) {
			const tz = prov.peakHours!.timezone;
			const ranges: [string, string][] = prov.peakHours!.ranges.map(([s, e]) => [`${s.toString().padStart(2, "0")}:00`, `${e.toString().padStart(2, "0")}:00`]);
			const weekdays = [...prov.peakHours!.weekdays];
			let n = 0;

			for (const modelId of modelIds) {
				const v1m = prov.models[modelId];
				let key = peakKeyOf(v1m);
				const hasOwnPeak = v1m.output.peak !== null;
				// 无峰价模型与有峰价模型不共用方案，key 里加区分位
				if (!hasOwnPeak) key = `no-peak|${key}`;
				if (!planIds.has(key)) {
					const suffix = n === 0 ? "" : `${n}`;
					const valleyId = `${providerId}-valley${suffix}`;
					const valleyPlanId = `${providerId}-valley-plan${suffix}`;
					out.prices[valleyId] = { name: `${providerId} 谷价${suffix || ""}`, input: { miss: v1m.input.miss, hit: v1m.input.hit }, output: v1m.output.standard };
					out.plans[valleyPlanId] = { name: `${providerId} 全时谷价${suffix || ""}`, rules: [{ schedule: { timezone: tz, weekdays: [], ranges: [] }, price: valleyId }] };
					let peakId: string | undefined;
					let peakPlanId: string | undefined;
					if (hasOwnPeak) {
						peakId = `${providerId}-peak${suffix}`;
						peakPlanId = `${providerId}-peak-plan${suffix}`;
						out.prices[peakId] = { name: `${providerId} 峰价${suffix || ""}`, input: { miss: v1m.input.miss, hit: v1m.input.hit }, output: v1m.output.peak! };
						out.plans[peakPlanId] = { name: `${providerId} 峰时段${suffix || ""}`, rules: [{ schedule: { timezone: tz, weekdays, ranges }, price: peakId }] };
					}
					planIds.set(key, { peakId, peakPlanId, valleyId, valleyPlanId });
					n += 1;
				}
				const ids = planIds.get(key)!;
				out.providers[providerId].models[modelId] = {
					alias: v1m.alias,
					plans: [
						...(ids.peakPlanId ? [{ plan: ids.peakPlanId, enabled: true }] : []),
						{ plan: ids.valleyPlanId, enabled: true },
					],
				};
			}
		} else {
			// 无峰：单 always 方案，按模型价格去重共享
			const keyOf = (m: PricingSchemaV1["providers"][string]["models"][string]) => `${m.input.miss}|${m.input.hit}|${m.output.standard}`;
			const planIds = new Map<string, { priceId: string; planId: string }>();
			let n = 0;
			for (const modelId of modelIds) {
				const v1m = prov.models[modelId];
				const key = keyOf(v1m);
				if (!planIds.has(key)) {
					const suffix = n === 0 ? "" : `${n}`;
					const priceId = `${providerId}-standard${suffix}`;
					const planId = `${providerId}-always${suffix}`;
					out.prices[priceId] = { name: `${providerId} 标准价${suffix || ""}`, input: { miss: v1m.input.miss, hit: v1m.input.hit }, output: v1m.output.standard };
					out.plans[planId] = { name: `${providerId} 全时标准价${suffix || ""}`, rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: priceId }] };
					planIds.set(key, { priceId, planId });
					n += 1;
				}
				const ids = planIds.get(key)!;
				out.providers[providerId].models[modelId] = { alias: v1m.alias, plans: [{ plan: ids.planId, enabled: true }] };
			}
		}
	}
	return out;
}

/** 深拷贝 v2 默认值（防止修改内置默认值） */
function cloneDefaults(): PricingSchemaV2 {
	return JSON.parse(JSON.stringify(DEFAULT_PRICING)) as PricingSchemaV2;
}

/** 读取 JSON；返回当前规范（v1 自动迁移 v2；不存在/损坏/v2 非法 → v2 默认值） */
export function readPricing(filePath: string = DEFAULT_PATH): PricingSchema {
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
	if (isV1(data)) return migrateV1ToV2(data);
	if (isValidV2(data)) return data;
	return cloneDefaults();
}

/** 写入 JSON 文件（创建目录 + 原子写入）；旧版本数据先迁移再落盘 */
export function writePricing(data: PricingSchema, filePath: string = DEFAULT_PATH): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const v2 = data.version === 2 ? data : migrateV1ToV2(data as unknown as PricingSchemaV1);
	writeFileSync(filePath, JSON.stringify(v2, null, "\t") + "\n", "utf8");
}

/** 首次启动 seeding：文件不存在时写入 v2 默认值 */
export function seedPricing(filePath: string = DEFAULT_PATH): void {
	try {
		const raw = readFileSync(filePath, "utf8");
		if (isV1(JSON.parse(raw))) {
			// v1 文件：原地迁移写回 v2（一次性主动落盘）
			const filePathStr = filePath;
			writePricing(migrateV1ToV2(JSON.parse(raw) as PricingSchemaV1), filePathStr);
			return;
		}
	} catch {
		// 文件不存在 / 损坏：走 seeding
	}
	if (!fileExists(filePath)) writePricing(cloneDefaults(), filePath);
}

/** 文件是否存在（readFileSync 探测） */
function fileExists(filePath: string): boolean {
	try {
		readFileSync(filePath, "utf8");
		return true;
	} catch {
		return false;
	}
}

/** 安全修改：读（自动迁移）→ 变更 → 写 v2（保证原子性） */
export function updatePricing(
	mutator: (data: PricingSchema) => PricingSchema,
	filePath: string = DEFAULT_PATH,
): PricingSchema {
	const data = readPricing(filePath);
	const updated = mutator(data);
	writePricing(updated, filePath);
	return updated;
}

/** 删除方案的引用保护：返回 {ok, reason}；被任一模型绑定则拒绝 */
export function checkPlanDeletable(schema: PricingSchema, planId: string): { ok: boolean; reason: string } {
	for (const [provId, prov] of Object.entries(schema.providers)) {
		for (const [modelId, model] of Object.entries(prov.models)) {
			if (model.plans.some((b) => b.plan === planId)) {
				return { ok: false, reason: `方案 "${planId}" 仍被 ${provId}/${modelId} 绑定` };
			}
		}
	}
	return { ok: true, reason: "" };
}

/** 删除价格实体的引用保护：返回 {ok, reason}；被任一规则引用则拒绝 */
export function checkPriceDeletable(schema: PricingSchema, priceId: string): { ok: boolean; reason: string } {
	for (const [planId, plan] of Object.entries(schema.plans)) {
		if (plan.rules.some((r) => r.price === priceId)) {
			return { ok: false, reason: `价格 "${priceId}" 仍被方案 "${planId}" 的规则引用` };
		}
	}
	return { ok: true, reason: "" };
}