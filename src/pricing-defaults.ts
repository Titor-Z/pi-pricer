/**
 * v5 内置种子数据（文件缺失 / 损坏 / 旧版本时使用）。
 *
 * 口径：
 * - 所有 _id 为不透明 16 位十六进制（与新建文档同构、随机观感）；可读性只由 name 承担。
 * - 种子内用局部变量串联引用（代码可读），落进数据的是不透明 id。
 * - createdAt 逐条递增（毫秒级），承载"创建先后 = 规则优先级"：后创建覆盖先创建。
 *   因此**兜底（全时）规则必须早于特例（峰时段）规则创建**，特例才能覆盖兜底。
 *
 * 数据来源：09-10 平台账单实测折算（¥/百万 token）。
 */

import type {
	CalendarDoc,
	ModelDoc,
	PlanDoc,
	PricingSchemaV5,
	RateDoc,
	RuleDoc,
} from "./pricing-types.ts";

/**
 * 固定不透明 id：把顺序号散列成 16 位十六进制。
 * 既保证测试可复现（确定性），又避免出现 `000…001` 这类"假 id"观感。
 */
const sid = (n: number): string =>
	((BigInt(n) * 0x9e3779b97f4a7c15n + 0x6a09e667f3bcc909n) & 0xffffffffffffffffn)
		.toString(16)
		.padStart(16, "0");

/** 种子时间基准（2026-09-10T00:00:00Z） */
const SEED_EPOCH = Date.parse("2026-09-10T00:00:00.000Z");

/** 按顺序号生成创建时间（每条差 1 秒，保证先后可辨） */
const seedTime = (seq: number): string => new Date(SEED_EPOCH + seq * 1000).toISOString();

// ── 价格（rates）id ──────────────────────────────────────────────────────
const RATE_DS_VALLEY = sid(1);
const RATE_DS_PEAK = sid(2);
const RATE_DS_PRO_VALLEY = sid(3);
const RATE_DS_PRO_PEAK = sid(4);
const RATE_GLM_STANDARD = sid(5);

// ── 规则（rules）id ──────────────────────────────────────────────────────
const RULE_DS_VALLEY_ALWAYS = sid(11);
const RULE_DS_PEAK_WORKDAY = sid(12);
const RULE_DS_PRO_VALLEY_ALWAYS = sid(13);
const RULE_DS_PRO_PEAK_WORKDAY = sid(14);
const RULE_GLM_ALWAYS = sid(15);

// ── 方案（plans）id ──────────────────────────────────────────────────────
const PLAN_DS_FLASH = sid(21);
const PLAN_DS_V4_PRO = sid(22);
const PLAN_GLM_FLASH = sid(23);

/** 工作日高峰时段（9-12、14-18，半开区间） */
const WORKDAY_PEAK_RANGES: [string, string][] = [
	["09:00", "12:00"],
	["14:00", "18:00"],
];
const WORKDAY_PEAK_WEEKDAYS = [1, 2, 3, 4, 5];

/** 构造价格文档 */
function rate(
	id: string,
	seq: number,
	name: string,
	inputMiss: number,
	inputHit: number,
	output: number,
): RateDoc {
	return { _id: id, createdAt: seedTime(seq), name, inputMiss, inputHit, output };
}

/** 构造规则文档（未用条件显式给空数组，避免 undefined 参与判断） */
function rule(partial: {
	id: string;
	seq: number;
	name: string;
	rateId: string;
	weekdays?: number[];
	ranges?: [string, string][];
}): RuleDoc {
	return {
		_id: partial.id,
		createdAt: seedTime(partial.seq),
		name: partial.name,
		rateId: partial.rateId,
		timezone: "Asia/Shanghai",
		weekdays: partial.weekdays ?? [],
		ranges: partial.ranges ?? [],
		includeCalendars: [],
		excludeCalendars: [],
		includeDates: [],
		excludeDates: [],
	};
}

/** 构造方案文档 */
function plan(id: string, seq: number, name: string, alias: string, ruleIds: string[]): PlanDoc {
	return { _id: id, createdAt: seedTime(seq), name, alias, enabled: true, ruleIds };
}

/** 构造模型文档 */
function model(seq: number, provider: string, modelName: string, planId: string): ModelDoc {
	return { _id: sid(seq), createdAt: seedTime(seq), provider, model: modelName, planId };
}

// ── 种子 ──────────────────────────────────────────────────────────────────

const rates: RateDoc[] = [
	rate(RATE_DS_VALLEY, 1, "DeepSeek 谷价", 1, 0.02, 4),
	rate(RATE_DS_PEAK, 2, "DeepSeek 峰价", 2, 0.04, 8),
	rate(RATE_DS_PRO_VALLEY, 3, "DeepSeek Pro 谷价", 4.5, 0.15, 13.5),
	rate(RATE_DS_PRO_PEAK, 4, "DeepSeek Pro 峰价", 9, 0.3, 27),
	rate(RATE_GLM_STANDARD, 5, "GLM 标准价", 0.8, 0.23, 2.8),
];

const calendars: CalendarDoc[] = [];

/**
 * 规则：兜底（全时）先创建，特例（峰时段）后创建。
 * 解析按 createdAt 升序评估、后命中覆盖先命中 → 峰时段内峰价覆盖谷价，其余时间谷价生效。
 */
const rules: RuleDoc[] = [
	rule({ id: RULE_DS_VALLEY_ALWAYS, seq: 11, name: "DeepSeek 全时谷价", rateId: RATE_DS_VALLEY }),
	rule({
		id: RULE_DS_PEAK_WORKDAY,
		seq: 12,
		name: "DeepSeek 工作日高峰",
		rateId: RATE_DS_PEAK,
		weekdays: WORKDAY_PEAK_WEEKDAYS,
		ranges: WORKDAY_PEAK_RANGES,
	}),
	rule({ id: RULE_DS_PRO_VALLEY_ALWAYS, seq: 13, name: "DeepSeek Pro 全时谷价", rateId: RATE_DS_PRO_VALLEY }),
	rule({
		id: RULE_DS_PRO_PEAK_WORKDAY,
		seq: 14,
		name: "DeepSeek Pro 工作日高峰",
		rateId: RATE_DS_PRO_PEAK,
		weekdays: WORKDAY_PEAK_WEEKDAYS,
		ranges: WORKDAY_PEAK_RANGES,
	}),
	rule({ id: RULE_GLM_ALWAYS, seq: 15, name: "GLM 全时标准价", rateId: RATE_GLM_STANDARD }),
];

const plans: PlanDoc[] = [
	plan(PLAN_DS_FLASH, 21, "deepseek-flash 方案", "Flash 默认", [RULE_DS_VALLEY_ALWAYS, RULE_DS_PEAK_WORKDAY]),
	plan(PLAN_DS_V4_PRO, 22, "deepseek-v4-pro 方案", "Pro 默认", [RULE_DS_PRO_VALLEY_ALWAYS, RULE_DS_PRO_PEAK_WORKDAY]),
	plan(PLAN_GLM_FLASH, 23, "glm-5.3-flash 方案", "GLM 默认", [RULE_GLM_ALWAYS]),
];

const models: ModelDoc[] = [
	model(31, "deepseek", "deepseek-flash", PLAN_DS_FLASH),
	model(32, "deepseek", "deepseek-v4-pro", PLAN_DS_V4_PRO),
	model(33, "glm", "glm-5.3-flash", PLAN_GLM_FLASH),
];

/** v5 内置种子（调用方须深拷贝后再改，避免污染本常量） */
export const DEFAULT_PRICING: PricingSchemaV5 = {
	version: 5,
	rates,
	calendars,
	rules,
	plans,
	models,
};
