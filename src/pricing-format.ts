/**
 * 格式化渲染：把 v2 数据渲染成终端可读文本。
 *
 * 输出风格对齐 pi-prompt /prompt usage：灰白阶 + 等宽对齐。
 * 模型卡片采用"基准 + 覆盖"投影：always 规则标 ←基准，其余为覆盖档。
 */

import type { PricingSchema } from "./pricing-types.ts";
import { listProviderModels, listProviders, resolveDebug } from "./pricing-query.ts";
import { readPricing } from "./pricing-store.ts";
import { describeSchedule, price } from "./pricing-desc.ts";
import { isAlwaysRule } from "./pricing-builder.ts";
import { GROUP_ORDER, GROUP_TITLES, PRICE_SUBCOMMANDS } from "./pricing-cli-spec.ts";

/** 渲染 /price list 总览：所有厂商 + 模型价目卡片 */
export function renderPriceList(filePath?: string): string {
	const providers = listProviders(filePath);
	if (providers.length === 0) return "暂无模型计费数据。";

	const lines: string[] = [];
	for (const prov of providers) {
		const infos = listProviderModels(prov, undefined, filePath);
		const planNames = [...new Set(infos.flatMap((i) => i.planBindings.map((b) => b.planName)))].join(" · ");
		lines.push("");
		lines.push(`${prov}  (${infos.length}模型 · ${planNames || "（无方案）"})`);
		for (const info of infos) {
			lines.push(modelBriefLine(info.model, info.alias));
			lines.push(...modelCardLines(prov, info.model, filePath));
		}
	}
	lines.push("");
	lines.push("文件: ~/.pi/model-pricing.json · 无参 /price 开抽屉 · 管理面: /price scheme|rate|calendar");
	return lines.join("\n");
}

/** 模型首行（平台名 + 别名） */
function modelBriefLine(model: string, alias?: string): string {
	return alias ? `  ${model} (aka ${alias})` : `  ${model}`;
}

/**
 * 单条绑定规则行：方案名 + 价格 + schedule 摘要；always 规则标 ←基准。
 * 禁用绑定不打价格行，仅标注。
 */
function ruleLine(planName: string, rulePrice: { inputMiss: number; inputHit: number; output: number }, scheduleDesc: string, isBase: boolean): string {
	return `      ${planName}  输出 ${price(rulePrice.output)} · 输入 未缓存 ${price(rulePrice.inputMiss)} / 缓存 ${price(rulePrice.inputHit)}  （${scheduleDesc}）${isBase ? "←基准" : ""}`;
}

/**
 * 模型价目卡片（"基准 + 覆盖"投影）：
 *   每条启用规则一行 → 实时生效行。实时行命中的方案名取自 resolveDebug 链尾。
 */
export function modelCardLines(provider: string, model: string, filePath?: string): string[] {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return [`  （未知厂商 ${provider}）`];
	const conf = findModelConfig(schema, prov, model);
	if (!conf) return [`  （未找到模型 ${model}）`];

	const lines: string[] = [];
	// 价格实体查询辅助（规则引用 → 数值）
	const priceOf = (id: string) => schema.prices[id];
	for (const binding of conf.plans) {
		const plan = schema.plans[binding.plan];
		if (!plan) {
			lines.push(`      ${binding.plan}（方案不存在，脏数据）${binding.enabled ? "" : "〔禁用〕"}`);
			continue;
		}
		if (!binding.enabled) {
			lines.push(`      ${plan.name}〔禁用〕`);
			continue;
		}
		for (const rule of plan.rules) {
			const p = priceOf(rule.price);
			const desc = describeSchedule(rule.schedule);
			if (!p) {
				lines.push(`      ${plan.name}（价格引用 ${rule.price} 缺失，脏数据）〔${desc}〕`);
				continue;
			}
			lines.push(ruleLine(plan.name, { inputMiss: p.input.miss, inputHit: p.input.hit, output: p.output }, desc, isAlwaysRule(rule)));
		}
	}

	// 实时生效行（resolveDebug 链尾 = 命中规则）
	const debug = resolveDebug(model, provider, undefined, filePath);
	const hitPlan = debug.chain.find((s) => s.matched)?.planName;
	const live = debug.price;
	lines.push(`      当前生效: 输出 ${price(live.output)} · 输入 未缓存 ${price(live.inputMiss)} / 缓存 ${price(live.inputHit)}${hitPlan ? `（命中 ${hitPlan}，${live.isPeak ? "高峰时段" : "普通时段"}）` : "（未命中→兜底价）"}`);
	return lines;
}

/** 在模型表中查找（精确 id → alias） */
function findModelConfig(
	schema: PricingSchema,
	prov: { models: Record<string, { alias?: string; plans: { plan: string; enabled: boolean }[] }> },
	model: string,
): { alias?: string; plans: { plan: string; enabled: boolean }[] } | undefined {
	if (prov.models[model]) return prov.models[model];
	for (const val of Object.values(prov.models)) {
		if (val.alias === model) return val;
	}
	return undefined;
}

/** /price model <provider> <model>：模型详情（绑定方案 + 实时生效 + 编辑提示） */
export function renderModelDetail(provider: string, model: string, filePath?: string): string {
	const schema = readPricing(filePath);
	const prov = schema.providers[provider];
	if (!prov) return `未知厂商: ${provider}`;
	const conf = findModelConfig(schema, prov, model);
	if (!conf) return `${provider} 下未找到模型: ${model}`;

	const lines: string[] = [];
	lines.push(`\n${provider}/${model}`);
	if (conf.alias) lines.push(`  别名: ${conf.alias}`);
	lines.push(`  绑定方案（${conf.plans.length} · 启用 ${conf.plans.filter((b) => b.enabled).length}）:`);
	lines.push(...modelCardLines(provider, model, filePath));
	lines.push("");
	lines.push("  编辑: 无参 /price 在抽屉内启停/增删绑定（Ctrl+S 保存）；排序用 /price move");
	return lines.join("\n");
}

/** /price schema：v2 结构说明 */
export function renderSchema(): string {
	return [
		"",
		"~/.pi/model-pricing.json Schema v2（五注册表原子化）",
		"",
		"结构:",
		"  calendars:  { \"<id>\": { name, dates: [\"YYYY-MM-DD\"|\"MM-DD\"] } }",
		"  prices:     { \"<id>\": { name, input: { miss, hit }, output } }",
		"  plans:      { \"<id>\": { name, rules: [ PricingRule ] } }",
		"  providers:  { \"<id>\": { models: { \"<model-id>\": ModelBilling } } }",
		"",
		"PricingRule:",
		'  { "schedule": Schedule, "price": "<price-id>", "validUntil": "YYYY-MM-DD"|null }',
		"Schedule:",
		'  { timezone, weekdays: [1..7], ranges: [["HH:MM","HH:MM")...],',
		'    calendar?: \"<id>\", calendarMode?: \"include\"|\"exclude\",',
		'    includeDates?: [\"MM-DD\"...], excludeDates?: [...] }',
		"ModelBilling:",
		'  { alias?, plans: [ { plan: \"<plan-id>\", enabled: bool } ] }',
		"",
		"语义:",
		"  - 数组顺序 = 优先级（绑定顺序 / 规则顺序），first match wins",
		"  - 剔除 = 更高优先级规则直接给结果，无 exclude 规则类型",
		"  - weekdays 与 ranges 同时为空 = 永远匹配（←基准）",
		"  - v1 文件读取时自动迁移为 v2",
	].join("\n");
}

/** /price scheme：方案列表 */
export function renderPlanList(filePath?: string): string {
	const schema = readPricing(filePath);
	const planIds = Object.keys(schema.plans);
	if (planIds.length === 0) return "暂无计费方案。";
	const lines: string[] = ["", "计费方案（数组内规则顺序 = 优先级，first match wins）", ""];
	for (const id of planIds) {
		const plan = schema.plans[id];
		const rules = plan.rules.map((r) => `${describeSchedule(r.schedule)} → ${schema.prices[r.price]?.name ?? r.price}`).join(" ; ");
		lines.push(`  ${id}  「${plan.name}」`);
		lines.push(`      ${rules || "（无规则）"}`);
	}
	return lines.join("\n");
}

/** /price scheme <id>：方案详情 */
export function renderPlanDetail(planId: string, filePath?: string): string {
	const schema = readPricing(filePath);
	const plan = schema.plans[planId];
	if (!plan) return `未找到方案: ${planId}`;
	const lines: string[] = [`\n${planId}  「${plan.name}」`, `  规则（${plan.rules.length}）:`];
	for (let i = 0; i < plan.rules.length; i++) {
		const r = plan.rules[i];
		const p = schema.prices[r.price];
		const until = r.validUntil ?? "无";
		if (!p) {
			lines.push(`    #${i}  ${describeSchedule(r.schedule)} → 价格引用缺失 ${r.price}（有效期至 ${until}）`);
		} else {
			lines.push(`    #${i}  ${describeSchedule(r.schedule)}`);
			lines.push(`         输出 ${price(p.output)} · 输入 未缓存 ${price(p.input.miss)} / 缓存 ${price(p.input.hit)}（有效期至 ${until}）${isAlwaysRule(r) ? " ←基准" : ""}`);
		}
	}
	lines.push("");
	lines.push("  编辑: /price scheme 直达方案管理页（Ctrl+S 保存）");
	return lines.join("\n");
}

/** /price rate：价格实体注册表 */
export function renderPriceRegistry(filePath?: string): string {
	const schema = readPricing(filePath);
	const ids = Object.keys(schema.prices);
	if (ids.length === 0) return "暂无价格实体。";
	const lines: string[] = ["", "价格实体（可被多个方案规则复用）", ""];
	for (const id of ids) {
		const p = schema.prices[id];
		const usedBy = Object.entries(schema.plans)
			.filter(([, plan]) => plan.rules.some((r) => r.price === id))
			.map(([pid]) => pid);
		lines.push(`  ${id}  「${p.name}」  输出 ${price(p.output)} · 输入 未缓存 ${price(p.input.miss)} / 缓存 ${price(p.input.hit)}`);
		lines.push(`      └ 被引用: ${usedBy.join("、") || "（无）"}`);
	}
	return lines.join("\n");
}

/** /price calendar：日历注册表 */
export function renderCalendarList(filePath?: string): string {
	const schema = readPricing(filePath);
	const ids = Object.keys(schema.calendars);
	if (ids.length === 0) return "暂无日历（节假日）资源。";
	const lines: string[] = ["", "日历资源（可被多个 schedule 引用）", ""];
	for (const id of ids) {
		const c = schema.calendars[id];
		const usedBy = Object.entries(schema.plans)
			.filter(([, plan]) => plan.rules.some((r) => r.schedule.calendar === id))
			.map(([pid]) => pid);
		const sample = c.dates.slice(0, 5).join("、") + (c.dates.length > 5 ? ` 等 ${c.dates.length} 天` : "");
		lines.push(`  ${id}  「${c.name}」  ${sample}`);
		lines.push(`      └ 被引用: ${usedBy.join("、") || "（无）"}`);
	}
	return lines.join("\n");
}

/** /price resolve <model> [provider] [ts]：调试器（命中链） */
export function renderResolveResult(model: string, provider: string, ts: Date | undefined, filePath?: string): string {
	const debug = resolveDebug(model, provider, ts, filePath);
	const lines: string[] = [];
	lines.push(`\n解析: ${provider}/${model}${ts ? ` @ ${ts.toISOString()}` : " @ 当前时刻"}`);
	if (debug.chain.length === 0) {
		lines.push("  未找到绑定/规则（模型不存在或未绑定方案）→ 兜底价");
	} else {
		for (const step of debug.chain) {
			const mark = step.matched ? "✓ 命中" : "✗ 未中";
			const which = step.ruleIndex >= 0 ? ` 方案「${step.planName}」规则#${step.ruleIndex}` : ` 方案「${step.planName}」`;
			lines.push(`    ${mark}${which}  ${step.reason}`);
			if (step.matched) break;
		}
	}
	const live = debug.price;
	lines.push(`  价格: 输出 ${price(live.output)} · 输入 未缓存 ${price(live.inputMiss)} / 缓存 ${price(live.inputHit)}${live.isPeak ? "（高峰时段）" : ""}${debug.matched ? "" : "（兜底价，未命中任何规则）"}`);
	return lines.join("\n");
}

/** /price help：命令用法（从 PRICE_SUBCOMMANDS 单一数据源派生，避免与实现漂移） */
export function renderHelp(): string {
	const lines: string[] = ["", "/price 模型计费（v2 五注册表原子化）", ""];

	for (const group of GROUP_ORDER) {
		const specs = PRICE_SUBCOMMANDS.filter((s) => s.group === group);
		if (specs.length === 0) continue;
		lines.push(`  ${GROUP_TITLES[group]}`);
		for (const spec of specs) {
			lines.push(padUsage(`    ${formatUsage(spec)}`, spec.summary, 38));
			// 二级动作单独列出（只列有参数提示的，避免刷屏）
			for (const child of spec.children ?? []) {
				if (!child.args?.length) continue;
				const childUsage = `        /price ${spec.name} ${child.name} ${child.args.map(argPlaceholder).join(" ")}`;
				lines.push(padUsage(childUsage, child.summary, 38));
			}
		}
		lines.push("");
	}

	lines.push("注: 绑定重排序只走 CLI（TUI 抽屉不提供上下移）。");
	lines.push("注: 命名沿革 — 原 plan/price 已改名 scheme/rate（避免 /price price 重复）。");
	return lines.join("\n");
}

/** 对 usage 与说明做列对齐（usage 超宽时至少留一个空格，避免文字粘连） */
function padUsage(usage: string, summary: string, column: number): string {
	return usage.length >= column ? `${usage}  ${summary}` : `${usage.padEnd(column)}${summary}`;
}

/** 位置参数语义名 → usage 里的占位符（provider → <p> 等，保持 help 紧凑） */
const ARG_PLACEHOLDERS: Record<string, string> = {
	provider: "<p>",
	model: "<m>",
	plan: "<plan>",
	price: "<id>",
	calendar: "<id>",
	id: "<id>",
	name: "[name]",
	field: "<field>",
	value: "<value>",
	dates: "<dates...>",
	ts: "[ts]",
	direction: "<up|down|top|bottom>",
};

/** 语义名 → 占位符（未知语义原样包角括号） */
function argPlaceholder(arg: string): string {
	return ARG_PLACEHOLDERS[arg] ?? `<${arg}>`;
}

/** 拼一条子命令的 usage（无参数则只留命令名） */
function formatUsage(spec: { name: string; args?: string[]; children?: Array<{ args?: string[] }> }): string {
	const base = `/price ${spec.name}`;
	if (spec.args?.length) return `${base} ${spec.args.map(argPlaceholder).join(" ")}`;
	// 无位置参数的子命令：若有带参数的二级动作，用 [<action>] 提示可下钻
	return spec.children?.some((c) => c.args?.length) ? `${base} [<action>]` : base;
}