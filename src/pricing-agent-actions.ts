/**
 * AI 辅助配置的语义动作定义（与 PricingDraft 的 mutator 一一对应）。
 *
 * 为什么单独一层：agent 通过工具传进来的必须是"结构化、可校验、可审计"的动作，
 * 而不是整份 JSON。这一层既是 typebox schema（供工具参数校验），
 * 也是 PricingAgentService 的分发依据，两处从同一份数据派生，避免漂移。
 *
 * 禁止：不要让 agent 直接用 edit/write 改 model-pricing.json —— 那样绕过
 * validate + 引用保护。见 AGENTS.md 认知记录。
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Static } from "typebox";

/** 价格字段（rate set 的 field 列，与 PricingDraft.setPriceField 一致） */
export const PRICE_FIELD_VALUES = ["input.miss", "input.hit", "output"] as const;

/** 日历引用模式 */
export const CALENDAR_MODE_VALUES = ["include", "exclude"] as const;

/** 绑定重排方向（与 PricingDraft.moveBinding 一致） */
export const MOVE_DIRECTION_VALUES = ["up", "down", "top", "bottom"] as const;

/** 单个语义动作的 schema（判别联合，供 LLM 工具参数用） */
export const PricingActionSchema = Type.Union([
	// 修改价格实体数值
	Type.Object({
		kind: Type.Literal("setPriceField"),
		priceId: Type.String({ description: "价格实体 id" }),
		field: StringEnum(PRICE_FIELD_VALUES),
		value: Type.Number({ minimum: 0, description: "¥/百万 token" }),
	}),
	// 新建/覆盖价格实体
	Type.Object({
		kind: Type.Literal("upsertPrice"),
		priceId: Type.String({ description: "价格实体 id（新建用）" }),
		name: Type.String({ description: "显示名" }),
		inputMiss: Type.Number({ minimum: 0, description: "缓存未命中输入价 ¥/百万 token" }),
		inputHit: Type.Number({ minimum: 0, description: "缓存命中输入价 ¥/百万 token" }),
		output: Type.Number({ minimum: 0, description: "输出价 ¥/百万 token" }),
	}),
	// 新建/覆盖方案（规则一次性给全，避免 agent 多次调用产生中间态）
	Type.Object({
		kind: Type.Literal("upsertPlan"),
		planId: Type.String({ description: "方案 id" }),
		name: Type.String({ description: "方案显示名" }),
		rules: Type.Array(
			Type.Object({
				price: Type.String({ description: "引用的价格实体 id" }),
				timezone: Type.Optional(Type.String({ description: "IANA 时区，默认 Asia/Shanghai" })),
				weekdays: Type.Optional(Type.Array(Type.Number({ minimum: 1, maximum: 7 }), { description: "1=周一…7=周日；空=任意" })),
				ranges: Type.Optional(Type.Array(Type.Tuple([Type.String(), Type.String()]), { description: '["HH:MM","HH:MM") 半开区间；空=全天' })),
				calendar: Type.Optional(Type.String({ description: "日历 id" })),
				calendarMode: Type.Optional(StringEnum(CALENDAR_MODE_VALUES)),
				includeDates: Type.Optional(Type.Array(Type.String({ description: "YYYY-MM-DD 或 MM-DD" }))),
				excludeDates: Type.Optional(Type.Array(Type.String({ description: "YYYY-MM-DD 或 MM-DD" }))),
				validUntil: Type.Optional(Type.String({ description: "YYYY-MM-DD，过期不参与匹配" })),
			}),
			{ minItems: 1, description: "至少一条规则；数组顺序 = 规则优先级" },
		),
	}),
	// 修改某条规则的价格引用
	Type.Object({
		kind: Type.Literal("setRulePrice"),
		planId: Type.String(),
		ruleIndex: Type.Number({ minimum: 0 }),
		priceId: Type.String(),
	}),
	// 绑定模型 → 方案（追加到末尾 = 最低优先级）
	Type.Object({
		kind: Type.Literal("bindModel"),
		provider: Type.String(),
		model: Type.String(),
		planId: Type.String(),
	}),
	// 解除模型绑定
	Type.Object({
		kind: Type.Literal("unbindModel"),
		provider: Type.String(),
		model: Type.String(),
		planId: Type.String(),
	}),
	// 调整绑定优先级
	Type.Object({
		kind: Type.Literal("moveBinding"),
		provider: Type.String(),
		model: Type.String(),
		planId: Type.String(),
		dir: StringEnum(MOVE_DIRECTION_VALUES),
	}),
	// 设置模型别名（空串 = 清除）
	Type.Object({
		kind: Type.Literal("setAlias"),
		provider: Type.String(),
		model: Type.String(),
		alias: Type.String({ description: "台账匹配用别名；空串清除" }),
	}),
	// 新建/覆盖日历
	Type.Object({
		kind: Type.Literal("upsertCalendar"),
		calendarId: Type.String(),
		name: Type.String(),
		dates: Type.Array(Type.String({ description: "YYYY-MM-DD 或 MM-DD（每年循环）" })),
	}),
	// 追加日历日期（去重保序）
	Type.Object({
		kind: Type.Literal("addCalendarDates"),
		calendarId: Type.String(),
		dates: Type.Array(Type.String(), { minItems: 1 }),
	}),
]);

/** 单个语义动作（已解析的类型） */
export type PricingAction = Static<typeof PricingActionSchema>;

/** 全部动作 kind 的枚举值（供一致性测试遍历，防分发漂移） */
export const PRICING_ACTION_KINDS = [
	"setPriceField",
	"upsertPrice",
	"upsertPlan",
	"setRulePrice",
	"bindModel",
	"unbindModel",
	"moveBinding",
	"setAlias",
	"upsertCalendar",
	"addCalendarDates",
] as const;

/** 动作 kind 类型 */
export type PricingActionKind = (typeof PRICING_ACTION_KINDS)[number];
