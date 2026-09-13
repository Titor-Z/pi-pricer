/**
 * 价表迁移：修正历史种子留下的错误绑定，并把开关语义从「方案级」迁到「模型级」。
 *
 * 背景：
 * - v0.13 初版种子的 GLM provider 写错（`glm`，pi 真实是 `zai`）
 * - DeepSeek 官方已改名：`deepseek-flash`（V4.1-Flash）为推荐名，旧名
 *   `deepseek-v4-flash` 仍可调用、按 Flash 价计费；而 pi 注册表当前仍用旧名。
 *   故两者都要绑（一个 plan 可被多个 model 绑定）。
 * - v0.14 曾把启停做在方案级（`PlanDoc.enabled`）；现改回**模型级**
 *   （`ModelDoc.enabled`），旧字段 `plan.enabled` 一律移除。
 *
 * 关键约束：别名补齐 / 残留清理**只对「未迁移的历史种子文件」做一次**，不能对已迁移
 * 文件反复处理 —— 否则用户在 TUI 里删掉的别名会被复活、手动禁用态会被重置。
 * 判据：出现 `provider: "glm"` 或旧种子方案名，即视为未迁移。
 *
 * 其余约定：
 * - 幂等：跑多少次结果一致
 * - 只修/补「绑定」与指向错误 id 的种子方案名，不动用户自定义的价格/规则/别名
 * - 不主动写盘：只在内存态生效，用户下次保存时自然落盘（对齐 pi-pricer 读不写盘约定）
 */

import type { ModelDoc, PlanDoc, PricingSchema } from "./pricing-types.ts";
import { generateId } from "./db/id.ts";

/** 历史种子方案名 → 修正名 */
const PLAN_RENAMES: Record<string, string> = {
	"deepseek-flash 方案": "deepseek-v4-flash 方案",
};

/** DeepSeek Flash 的当前官方名与 pi 注册表旧名（两者都绑同一方案） */
const DEEPSEEK_FLASH_ALIASES = ["deepseek-v4-flash", "deepseek-flash"];

/** 是否历史种子（未迁移）：出现 glm provider 或旧种子方案名 */
function isLegacySeed(schema: PricingSchema): boolean {
	return (
		schema.models.some((m) => m.provider === "glm") ||
		schema.plans.some((p) => p.name in PLAN_RENAMES)
	);
}

/** 归一化单个模型绑定：provider glm → zai；补齐 enabled（历史文件残留一律清为启用） */
function normalizeModel(doc: ModelDoc, legacy: boolean): { changed: boolean; doc: ModelDoc } {
	const next: ModelDoc = { ...doc };
	let changed = false;
	if (next.provider === "glm") {
		next.provider = "zai";
		changed = true;
	}
	const wantEnabled = legacy ? true : (next.enabled ?? true);
	if (next.enabled !== wantEnabled) {
		next.enabled = wantEnabled;
		changed = true;
	}
	return { changed, doc: next };
}

/** 移除方案上的旧 `enabled` 字段（必要时改名） */
function normalizePlans(schema: PricingSchema, legacy: boolean): { changed: boolean; plans: PlanDoc[] } {
	const planNames = new Set(schema.plans.map((p) => p.name));
	const needsFieldFix = schema.plans.some((p) => "enabled" in (p as unknown as Record<string, unknown>));
	const needsRename = legacy && schema.plans.some((p) => p.name in PLAN_RENAMES);
	if (!needsFieldFix && !needsRename) return { changed: false, plans: schema.plans };
	const plans = schema.plans.map((p) => {
		const next = { ...p } as PlanDoc & { enabled?: boolean };
		delete next.enabled;
		const target = PLAN_RENAMES[next.name];
		if (legacy && target && !planNames.has(target)) next.name = target;
		return next as PlanDoc;
	});
	return { changed: true, plans };
}

/** 应用迁移（幂等）；无变更时原样返回 */
export function migrateSchema(schema: PricingSchema): PricingSchema {
	const legacy = isLegacySeed(schema);
	let changed = false;

	// ── 1) 模型绑定：provider glm → zai、补 enabled、去重 ──
	const result: ModelDoc[] = [];
	const keys = new Set<string>();
	const keyOf = (m: ModelDoc): string => `${m.provider}/${m.model}`;
	const push = (m: ModelDoc): void => {
		const key = keyOf(m);
		if (keys.has(key)) return;
		keys.add(key);
		result.push(m);
	};
	// 先收无需变更的（重复时优先保留本就正确的记录）
	for (const m of schema.models) {
		if (!normalizeModel(m, legacy).changed) push(m);
	}
	for (const m of schema.models) {
		const { changed: c, doc } = normalizeModel(m, legacy);
		if (c) push(doc);
	}
	if (result.length !== schema.models.length || result.some((m, i) => m !== schema.models[i])) {
		changed = true;
	}

	// ── 2) 补齐 DeepSeek Flash 双别名（仅历史种子，做一次）──
	if (legacy) {
		const flashModels = result.filter(
			(m) => m.provider === "deepseek" && DEEPSEEK_FLASH_ALIASES.includes(m.model),
		);
		if (flashModels.length > 0) {
			const present = new Set(flashModels.map((m) => m.model));
			for (const alias of DEEPSEEK_FLASH_ALIASES) {
				if (present.has(alias)) continue;
				result.push({
					_id: generateId(),
					createdAt: new Date().toISOString(),
					provider: "deepseek",
					model: alias,
					planId: flashModels[0].planId,
					enabled: true,
				});
				changed = true;
			}
		}
	}

	// ── 3) 方案：移除旧 enabled 字段（必要时改种子方案名）──
	const planFix = normalizePlans(schema, legacy);
	if (planFix.changed) changed = true;

	return changed ? { ...schema, models: result, plans: planFix.plans } : schema;
}
