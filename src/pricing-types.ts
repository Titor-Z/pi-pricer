/**
 * 模型计费 Schema 类型定义（JSON v1）。
 *
 * 设计原则：
 * - 价格单位统一为 ¥/百万 token（与行业惯例一致）
 * - 峰时段按星期×小时段循环（覆盖90%+计费场景）
 * - alias 单数 string（多数模型只有一个别名）
 * - 缺省字段有合理默认值，向后兼容
 */

/** 峰时段定义：按星期 × 小时段循环 */
export interface PeakHours {
	/** IANA 时区名（如 "Asia/Shanghai"） */
	timezone: string;
	/** 星期几（1=周一 ... 7=周日） */
	weekdays: number[];
	/** 小时段 [start, end) 半开区间（如 [[9,12],[14,18]] 表示 9-11:59 和 14-17:59） */
	ranges: [number, number][];
}

/** 模型输入价（¥/百万 token） */
export interface InputPricing {
	/** 缓存未命中（input_cache_miss_tokens） */
	miss: number;
	/** 缓存命中（input_cache_hit_tokens） */
	hit: number;
}

/** 模型输出价（¥/百万 token） */
export interface OutputPricing {
	/** 空闲价 */
	standard: number;
	/** 峰价（null = 无峰谷，恒用 standard） */
	peak: number | null;
}

/** 单个模型的计费参数 */
export interface ModelPricing {
	/** pi 内部 model 名的别名（台账匹配用；如 "deepseek-v4-flash"） */
	alias?: string;
	/** 输入价 */
	input: InputPricing;
	/** 输出价 */
	output: OutputPricing;
}

/** 单个厂商的计费参数 */
export interface ProviderPricing {
	/** 峰时段规则（null = 无峰谷，恒用 standard 价） */
	peakHours: PeakHours | null;
	/** 该厂商下的模型列表（key = 平台注册名） */
	models: Record<string, ModelPricing>;
}

/** JSON Schema v1 根结构 */
export interface PricingSchema {
	/** Schema 版本号（前向兼容） */
	version: 1;
	/** 厂商列表（key = provider id，与台账 provider 字段一致） */
	providers: Record<string, ProviderPricing>;
}

/** resolvePricing 的返回值 */
export interface ResolvedPrice {
	/** 缓存未命中输入价（¥/百万 token） */
	inputMiss: number;
	/** 缓存命中输入价（¥/百万 token） */
	inputHit: number;
	/** 输出价（¥/百万 token，已根据峰谷选择 standard 或 peak） */
	output: number;
	/** 当前是否处于峰时段 */
	isPeak: boolean;
}

/** JSON 文件路径 */
export const PRICING_PATH = "~/.pi/model-pricing.json";
