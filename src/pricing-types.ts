/**
 * 模型计费 Schema v5 类型定义（document 模型，对齐 Mongo 语义）。
 *
 * 设计要点（对应 v5 讨论定稿）：
 * - 五个集合：rates / calendars / rules / plans / models，互相以 _id 引用（跨表 join）
 * - 每条文档有自动生成的 _id（不可读）+ createdAt；可读性由各表唯一 name 承担
 * - 规则（RuleDoc）= 时间条件 + 一个价格引用；「组合规避减法」——峰谷用多条规则表达
 * - 方案（PlanDoc）= 规则组（ruleIds），是模型唯一对接对象；模型不直接面对规则
 * - 模型 → 方案为单值绑定（planId），plan 可启用/禁用
 * - 规则优先级：按 createdAt 升序评估，后创建覆盖先创建（last-match-wins）
 *
 * 旧 v1/v2/v3 结构与本文不兼容：读到时一律回退为 v5 内置种子（见 pricing-store.ts）。
 */

import type { Document } from "./db/document.ts";

// ── 集合文档 ──────────────────────────────────────────────────────────────

/** 价格：纯数值声明，不含任何时间条件 */
export interface RateDoc extends Document {
	/** 显示名（集合内唯一） */
	name: string;
	/** 缓存未命中输入价（¥/百万 token） */
	inputMiss: number;
	/** 缓存命中输入价（¥/百万 token） */
	inputHit: number;
	/** 输出价（¥/百万 token） */
	output: number;
}

/** 日历：命名日期资源（法定节假日 / 民俗假日 / 促销日等） */
export interface CalendarDoc extends Document {
	/** 显示名（集合内唯一） */
	name: string;
	/** 地区标记（如 "CN"、"JP"），可选，仅作说明 */
	region?: string;
	/** 日期列表："YYYY-MM-DD"（精确）或 "MM-DD"（每年循环） */
	dates: string[];
}

/** 规则：时间条件 + 单个价格引用 */
export interface RuleDoc extends Document {
	/** 显示名（集合内唯一） */
	name: string;
	/** 引用的价格文档 _id */
	rateId: string;
	/** IANA 时区名（如 "Asia/Shanghai"） */
	timezone: string;
	/** 星期（1=周一 … 7=周日）；空数组 = 任意星期 */
	weekdays: number[];
	/** 时段 ["HH:MM", "HH:MM") 半开区间；空数组 = 全天；跨天拆两段 */
	ranges: [string, string][];
	/** 应用哪些日历（任一命中即算命中）；空数组 = 不启用日历包含 */
	includeCalendars: string[];
	/** 排除哪些日历（任一命中即不匹配）；空数组 = 不排除 */
	excludeCalendars: string[];
	/** 指定日期（命中即匹配，覆盖周规则） */
	includeDates: string[];
	/** 排除日期（命中即不匹配） */
	excludeDates: string[];
	/** 截止日期（"YYYY-MM-DD"）；过期即不参与匹配；短期规则用，循环规则留空 */
	validUntil?: string;
}

/** 方案：规则组，模型唯一对接对象 */
export interface PlanDoc extends Document {
	/** 显示名（集合内唯一） */
	name: string;
	/** 别名：HUD/footer 短名（可选） */
	alias?: string;
	/** 引用的规则 _id 列表（集合 = 该方案包含的规则） */
	ruleIds: string[];
}

/** 模型：厂商 + 模型名 + 绑定的方案 */
export interface ModelDoc extends Document {
	/** 厂商（台账 provider 字段） */
	provider: string;
	/** 模型注册名 */
	model: string;
	/** 绑定的方案 _id（单值） */
	planId: string;
	/** 是否启用；禁用后**仅该模型**走兜底价（不影响同方案其它模型） */
	enabled: boolean;
}

// ── 根结构 ────────────────────────────────────────────────────────────────

/** JSON Schema v5 根结构：五个独立集合 */
export interface PricingSchemaV5 {
	version: 5;
	rates: RateDoc[];
	calendars: CalendarDoc[];
	rules: RuleDoc[];
	plans: PlanDoc[];
	models: ModelDoc[];
}

/** 当前数据根类型（对外统一暴露） */
export type PricingSchema = PricingSchemaV5;

/** 集合名（错误信息与 DAO 访问器共用） */
export type CollectionName = "rates" | "calendars" | "rules" | "plans" | "models";

// ── 对外解析 API ──────────────────────────────────────────────────────────

/**
 * 解析结果（对外稳定契约，pi-usager / pi-prompt 消费）。
 * 未命中任何规则（兜底价）时：来源元数据字段为 undefined。
 */
export interface ResolvedPrice {
	/** 缓存未命中输入价（¥/百万 token） */
	inputMiss: number;
	/** 缓存命中输入价（¥/百万 token） */
	inputHit: number;
	/** 输出价（¥/百万 token） */
	output: number;
	/** 命中规则是否带时段/星期约束（供消费方区分特殊时段，不参与计价） */
	isPeak: boolean;
	/** 命中方案 _id */
	planId?: string;
	/** 命中方案显示名 */
	planName?: string;
	/** 命中方案别名（HUD 短名） */
	planAlias?: string;
	/** 命中价格 _id */
	rateId?: string;
	/** 命中规则 _id */
	ruleId?: string;
}

/** 命中/未命中链上一步的信息 */
export interface ResolutionStep {
	/** 被评估的规则 _id */
	ruleId: string;
	/** 规则显示名 */
	ruleName: string;
	/** 规则引用的价格 _id */
	rateId: string;
	/** 是否命中 */
	matched: boolean;
	/** 命中说明 / 未命中原因 */
	reason: string;
}

/** 解析调试结果（命中链 + 最终价格） */
export interface ResolutionDebug {
	/** 解析出的价格（未命中时为首选兜底价） */
	price: ResolvedPrice;
	/** 按评估顺序排列的步骤链（已评估全部规则，含覆盖过程） */
	chain: ResolutionStep[];
	/** 是否命中任意规则（false = 用了兜底价） */
	matched: boolean;
}

/** 兜底价（未配置 / 方案禁用 / 全不命中时返回；数据来源：09-10 平台账单实测谷价） */
export const FALLBACK_PRICE: ResolvedPrice = {
	inputMiss: 1,
	inputHit: 0.02,
	output: 4,
	isPeak: false,
};

/** JSON 文件路径（命令行描述用） */
export const PRICING_PATH = "~/.pi/model-pricing.json";
