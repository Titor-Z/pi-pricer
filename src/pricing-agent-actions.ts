/**
 * AI 辅助配置的语义动作定义（与 PricingAgentService 的分发一一对应）。
 *
 * 为什么单独一层：agent 通过工具传进来的是"结构化、可校验、可审计"的动作，
 * 而不是整份 JSON；这层既是 typebox schema（工具参数校验），也是服务层的分发依据。
 *
 * 引用约定：动作里一律用**各表的 name**（唯一）引用实体，而非 _id
 * —— 让 LLM 无需记忆 / 生成不可读的 id。服务层负责 name → _id 解析。
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "typebox";

/** 价格可改字段（与 rate 命令一致） */
export const PRICE_FIELD_VALUES = ["inputMiss", "inputHit", "output"] as const;

/** 单个语义动作的 schema（判别联合） */
export const PricingActionSchema = Type.Union([
	// 新建/更新价格（按 name 定位；存在则覆盖数值）
	Type.Object({
		kind: Type.Literal("upsertRate"),
		name: Type.String({ description: "价格显示名（全表唯一）" }),
		inputMiss: Type.Number({ minimum: 0, description: "缓存未命中输入价 ¥/百万 token" }),
		inputHit: Type.Number({ minimum: 0, description: "缓存命中输入价 ¥/百万 token" }),
		output: Type.Number({ minimum: 0, description: "输出价 ¥/百万 token" }),
	}),
	// 删除价格（被规则引用时整批拒绝）
	Type.Object({
		kind: Type.Literal("deleteRate"),
		name: Type.String(),
	}),
	// 新建/更新日历（dates 为覆盖式）
	Type.Object({
		kind: Type.Literal("upsertCalendar"),
		name: Type.String({ description: "日历显示名（全表唯一）" }),
		dates: Type.Array(Type.String({ description: "YYYY-MM-DD 或 MM-DD（每年循环）" })),
		region: Type.Optional(Type.String({ description: "地区标记，如 CN" })),
	}),
	// 追加日期（去重保序）
	Type.Object({
		kind: Type.Literal("addCalendarDates"),
		name: Type.String(),
		dates: Type.Array(Type.String(), { minItems: 1 }),
	}),
	Type.Object({
		kind: Type.Literal("deleteCalendar"),
		name: Type.String(),
	}),
	// 新建/更新规则（按 name 定位；提供的字段整体覆盖）
	Type.Object({
		kind: Type.Literal("upsertRule"),
		name: Type.String({ description: "规则显示名（全表唯一）" }),
		rateName: Type.String({ description: "引用的价格 name" }),
		timezone: Type.Optional(Type.String({ description: "IANA 时区，默认 Asia/Shanghai" })),
		weekdays: Type.Optional(Type.Array(Type.Number({ minimum: 1, maximum: 7 }), { description: "1=周一…7=周日；空=任意" })),
		ranges: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]), { description: '["HH:MM","HH:MM") 半开区间；空=全天' })),
		includeCalendars: Type.Optional(Type.Array(Type.String({ description: "日历 name" }))),
		excludeCalendars: Type.Optional(Type.Array(Type.String({ description: "日历 name" }))),
		includeDates: Type.Optional(Type.Array(Type.String())),
		excludeDates: Type.Optional(Type.Array(Type.String())),
		validUntil: Type.Optional(Type.String({ description: "YYYY-MM-DD；过期不参与匹配" })),
	}),
	Type.Object({
		kind: Type.Literal("deleteRule"),
		name: Type.String(),
	}),
	// 新建/更新方案（ruleNames 覆盖式设置成员）
	Type.Object({
		kind: Type.Literal("upsertPlan"),
		name: Type.String({ description: "方案显示名（全表唯一）" }),
		alias: Type.Optional(Type.String({ description: "HUD 短名；可省略" })),
		ruleNames: Type.Optional(Type.Array(Type.String({ description: "规则 name" }))),
	}),
	// 切换某模型的启用/禁用（模型级，不影响同方案其它模型）
	Type.Object({
		kind: Type.Literal("setModelEnabled"),
		provider: Type.String(),
		model: Type.String(),
		enabled: Type.Boolean(),
	}),
	Type.Object({
		kind: Type.Literal("deletePlan"),
		name: Type.String(),
	}),
	// 绑定模型 → 方案（模型不存在则创建；存在则改绑）
	Type.Object({
		kind: Type.Literal("bindModel"),
		provider: Type.String(),
		model: Type.String(),
		planName: Type.String({ description: "方案 name" }),
	}),
	// 解绑模型（删除模型文档）
	Type.Object({
		kind: Type.Literal("unbindModel"),
		provider: Type.String(),
		model: Type.String(),
	}),
]);

/** 单个语义动作（已解析类型） */
export type PricingAction = Static<typeof PricingActionSchema>;

/** 全部动作 kind（供一致性测试遍历，防分发漂移） */
export const PRICING_ACTION_KINDS = [
	"upsertRate",
	"deleteRate",
	"upsertCalendar",
	"addCalendarDates",
	"deleteCalendar",
	"upsertRule",
	"deleteRule",
	"upsertPlan",
	"setModelEnabled",
	"deletePlan",
	"bindModel",
	"unbindModel",
] as const;

/** 动作 kind 类型 */
export type PricingActionKind = (typeof PRICING_ACTION_KINDS)[number];
