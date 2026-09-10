/**
 * 模型计费 Schema v2 类型定义。
 *
 * 设计原则（五注册表原子化，对应 AGENTS.md v0.4）：
 * - prices / calendars / plans / providers(models+plans) 独立注册表
 * - 计划（plans）= 聚合根：多条规则（rules），数组顺序 = 规则优先级
 * - 规则（rule）= 时间条件 + 价格引用；"剔除"用更高优先级规则表达，不做排除语义
 * - 模型绑定（bindings）= 有序数组，数组顺序 = 绑定优先级（first match wins）
 * - 价格单位统一 ¥/百万 token；时区高峰期按 schedule 匹配
 * - v1→v2 数据结构不兼容，store 层做自动迁移（见 pricing-store.ts）
 */

/** 日历注册表：命名日期资源，可被多个规则的 schedule 引用 */
export interface CalendarEntry {
	/** 日历显示名（如 "中国法定节假日"） */
	name: string;
	/** 日期列表；"YYYY-MM-DD"（单年）或 "MM-DD"（每年循环） */
	dates: string[];
}

/** 价格实体（可复用，多个规则可引用同一 price id） */
export interface PriceEntity {
	/** 价格显示名（如 "DeepSeek 谷价"） */
	name: string;
	/** 输入价（¥/百万 token）：miss=缓存未命中，hit=缓存命中 */
	input: { miss: number; hit: number };
	/** 输出价（¥/百万 token） */
	output: number;
}

/** 时间条件：统一承载 时段 / 周循环 / 日历 / 具体日期 / 日期范围 */
export interface Schedule {
	/** IANA 时区名（如 "Asia/Shanghai"） */
	timezone: string;
	/** 星期（1=周一 ... 7=周日）；空数组 = 任意星期 */
	weekdays: number[];
	/** 时段 ["HH:MM", "HH:MM") 半开区间；跨天请拆成两段；空数组 = 全天 */
	ranges: [string, string][];
	/** 日历引用（M3 管理）；calendarMode=include 仅这些日期 / exclude 剔除 */
	calendar?: string;
	calendarMode?: "include" | "exclude";
	/** 具体日期覆盖周规则（最具体，如加班/促销日） */
	includeDates?: string[];
	/** 排除日期（如法定节假日） */
	excludeDates?: string[];
}

/** 计费规则：在什么时间条件下用什么价格；数组顺序 = 规则优先级 */
export interface PricingRule {
	/** 时间条件；weekdays 与 ranges 同时为空 = 永远匹配（基准价） */
	schedule: Schedule;
	/** 引用的价格实体 id（prices 注册表） */
	price: string;
	/** 规则截止日期（"YYYY-MM-DD"）；过期即不参与匹配 */
	validUntil?: string | null;
}

/** 计费方案（聚合根）：清单管理面 */
export interface PricingPlan {
	/** 方案显示名（可自定义） */
	name: string;
	/** 规则列表，数组顺序 = 优先级，first match wins */
	rules: PricingRule[];
}

/** 模型 → 方案的绑定（数组顺序 = 优先级） */
export interface PlanBinding {
	/** 方案 id */
	plan: string;
	/** 启用开关（禁用 = 软停用，不删除） */
	enabled: boolean;
}

/** 单个模型的计费配置 */
export interface ModelBilling {
	/** pi 内部 model 名的别名（台账匹配用） */
	alias?: string;
	/** 绑定的计费方案列表，数组顺序 = 绑定优先级 */
	plans: PlanBinding[];
}

/** 单个厂商的模型分组（provider = 台账 provider 字段，退化建模分组） */
export interface ProviderBilling {
	/** 该厂商下的模型（key = 平台注册名） */
	models: Record<string, ModelBilling>;
}

/** JSON Schema v2 根结构：五注册表 */
export interface PricingSchemaV2 {
	version: 2;
	/** 日历注册表 */
	calendars: Record<string, CalendarEntry>;
	/** 价格注册表（可复用实体） */
	prices: Record<string, PriceEntity>;
	/** 计费方案注册表 */
	plans: Record<string, PricingPlan>;
	/** 厂商 → 模型 → 方案绑定 */
	providers: Record<string, ProviderBilling>;
}

/** v1 旧数据结构（仅供 store 迁移读取；结构与 v2 不兼容） */
export interface PricingSchemaV1 {
	version: 1;
	providers: Record<string, {
		peakHours: PeakHours | null;
		models: Record<string, {
			alias?: string;
			input: { miss: number; hit: number };
			output: { standard: number; peak: number | null };
		}>;
	}>;
}

/** v2 当前数据根类型（对外统一暴露） */
export type PricingSchema = PricingSchemaV2;

/**
 * v1 的峰时段定义（按星期×小时段循环）。
 * 保留类型仅供 v1→v2 迁移解析用；v2 不再有 provider 级 peakHours。
 */
export interface PeakHours {
	/** IANA 时区名（如 "Asia/Shanghai"） */
	timezone: string;
	/** 星期几（1=周一 ... 7=周日） */
	weekdays: number[];
	/** 小时段 [start, end) 整数小时（如 [[9,12],[14,18]]） */
	ranges: [number, number][];
}

/** resolvePricing 的返回值（公共 API 保持稳定，pi-prompt 依赖此结构） */
export interface ResolvedPrice {
	/** 缓存未命中输入价（¥/百万 token） */
	inputMiss: number;
	/** 缓存命中输入价（¥/百万 token） */
	inputHit: number;
	/** 输出价（¥/百万 token，当前命中价格） */
	output: number;
	/**
	 * 命中规则是否为"时间窗规则"（schedule 含 weekdays/ranges）。
	 * v2 无独立"峰/谷"概念，此字段降级为时间段规则标记（仅提示当时是否为特殊时段）。
	 */
	isPeak: boolean;
}

/** 命中/未命中链上一步的调试信息 */
export interface ResolutionStep {
	/** 命中的规则所属方案 id */
	planId: string;
	/** 方案显示名 */
	planName: string;
	/** 规则在方案 rules 中的下标 */
	ruleIndex: number;
	/** 规则引用的价格实体 id */
	priceId: string;
	/** 是否命中（未命中时 reason 说明原因） */
	matched: boolean;
	/** 未命中原因 / 命中说明 */
	reason: string;
}

/** resolveDebug 的返回：价格 + 命中链（/price resolve 调试器用） */
export interface ResolutionDebug {
	/** 解析出的价格（未命中时为首选兜底价） */
	price: ResolvedPrice;
	/** 按匹配顺序评估的步骤链（第一条 matched=true 的为止） */
	chain: ResolutionStep[];
	/** 是否命中任意规则（false = 用了兜底价） */
	matched: boolean;
}

/** JSON 文件路径（命令行描述用） */
export const PRICING_PATH = "~/.pi/model-pricing.json";