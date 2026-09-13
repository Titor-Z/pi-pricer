/**
 * pi-pricer v5 解析链测试：覆盖语义、日历 include/exclude、有效期、方案禁用、批量闭包。
 *
 * 约定：临时目录隔离 IO；jiti 直载 src/*.ts；路径从 import.meta.url 派生。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const { resolvePricing, resolveDebug, createPricingResolver } = await jiti.import(`${SRC}/pricing-query.ts`);
const { Database } = await jiti.import(`${SRC}/db/database.ts`);
const { DEFAULT_PRICING } = await jiti.import(`${SRC}/pricing-defaults.ts`);
const { writePricing } = await jiti.import(`${SRC}/pricing-store.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-q-"));
}

/**
 * 内置种子写入一个临时文件，供所有用例共用。
 * 重要：绝不能依赖默认路径（~/.pi/model-pricing.json）—— 用户真实配置会污染测试。
 */
const SEED_DIR = tmpDir();
const SEED_PATH = join(SEED_DIR, "seed.json");
writePricing(structuredClone(DEFAULT_PRICING), SEED_PATH);

/** 周二 10:00 北京（工作日峰窗内） */
const PEAK = new Date("2026-09-15T02:00:00Z");
/** 周二 21:00 北京（非峰） */
const IDLE = new Date("2026-09-15T13:00:00Z");
/** 周日 12:00 北京 */
const SUN = new Date("2026-09-20T04:00:00Z");

test("resolve：峰时段命中峰价、非峰/周末命中谷价（后创建覆盖先创建）", () => {
	const peak = resolvePricing("deepseek-flash", "deepseek", PEAK, SEED_PATH);
	assert.equal(peak.output, 8, "峰时输出价");
	assert.equal(peak.isPeak, true, "命中带时间窗的规则");
	assert.equal(peak.planName, "deepseek-flash 方案");
	assert.equal(peak.planAlias, "Flash 默认");
	assert.ok(peak.ruleId && peak.rateId, "应带出规则/价格来源 _id");

	const idle = resolvePricing("deepseek-flash", "deepseek", IDLE, SEED_PATH);
	assert.equal(idle.output, 4, "非峰输出价");
	assert.equal(idle.isPeak, false);
	assert.notEqual(idle.ruleId, peak.ruleId, "不同时段命中不同规则");

	const sun = resolvePricing("deepseek-flash", "deepseek", SUN, SEED_PATH);
	assert.equal(sun.output, 4, "周末走谷价");
});

test("resolve：命中链按创建顺序、可看到覆盖过程", () => {
	const dbg = resolveDebug("deepseek-flash", "deepseek", PEAK, SEED_PATH);
	assert.equal(dbg.matched, true);
	// 兜底规则先创建、峰规则后创建 → 链序：谷 → 峰
	assert.equal(dbg.chain[0].ruleName, "DeepSeek 全时谷价");
	assert.equal(dbg.chain[1].ruleName, "DeepSeek 工作日高峰");
	assert.ok(dbg.chain.every((step) => step.matched), "峰时应两条都命中");
});

test("resolve：未知模型 / 未绑定模型 → 兜底价", () => {
	const unknown = resolvePricing("no-such-model", "deepseek", PEAK, SEED_PATH);
	assert.equal(unknown.output, 4);
	assert.equal(unknown.planId, undefined, "兜底时无来源信息");
	assert.equal(unknown.isPeak, false);
});

test("resolve：方案禁用 → 兜底价，且命中链说明原因", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const plan = db.plans.findOne((x) => x.name === "deepseek-flash 方案");
	db.transaction((tx) => {
		tx.plans.updateOne(plan._id, { enabled: false });
	});
	const price = resolvePricing("deepseek-flash", "deepseek", PEAK, p);
	assert.equal(price.output, 4, "禁用方案走兜底");
	assert.equal(price.planId, undefined);
	const dbg = resolveDebug("deepseek-flash", "deepseek", PEAK, p);
	assert.ok(dbg.chain.some((s) => s.reason.includes("已禁用")), "链应说明方案禁用");
	rmSync(dir, { recursive: true, force: true });
});

test("resolve：规则有效期过期 → 该规则不参与匹配", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const plan = db.plans.findOne((x) => x.name === "deepseek-flash 方案");
	const peakRule = db.rules.findOne((r) => r.name === "DeepSeek 工作日高峰");
	db.transaction((tx) => {
		// 让峰规则在 2026-09-14 到期 → 9-15 峰时不再命中峰价
		tx.rules.updateOne(peakRule._id, { validUntil: "2026-09-14" });
	});
	const price = resolvePricing("deepseek-flash", "deepseek", PEAK, p);
	assert.equal(price.output, 4, "过期峰规则失效 → 谷价");
	assert.equal(plan._id, price.planId, "仍属同一方案");
	rmSync(dir, { recursive: true, force: true });
});

test("resolve：日历 include（仅节假日生效）与 exclude（节假日排除）", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	// 造一个"促销日"日历：2026-09-15（正好是本次峰时那天）
	const calId = db.transaction((tx) => {
		const cal = tx.calendars.insertOne({ name: "促销日", dates: ["2026-09-15"] });
		const rate = tx.rates.insertOne({ name: "促销价", inputMiss: 0.1, inputHit: 0.01, output: 1 });
		// 促销规则：仅促销日 + 不限定周/时段（后创建 → 覆盖一切）
		const rule = tx.rules.insertOne({
			name: "促销规则",
			rateId: rate._id,
			timezone: "Asia/Shanghai",
			weekdays: [],
			ranges: [],
			includeCalendars: [cal._id],
			excludeCalendars: [],
			includeDates: [],
			excludeDates: [],
		});
		const plan = tx.plans.findOne((x) => x.name === "deepseek-flash 方案");
		tx.plans.updateOne(plan._id, { ruleIds: [...plan.ruleIds, rule._id] });
		return cal._id;
	});
	assert.ok(calId);
	const onPromo = resolvePricing("deepseek-flash", "deepseek", PEAK, p);
	assert.equal(onPromo.output, 1, "促销日命中促销价（覆盖峰价）");
	const offPromo = resolvePricing("deepseek-flash", "deepseek", SUN, p);
	assert.equal(offPromo.output, 4, "非促销日（周日）走谷价（include 日历不满足）");

	// 再验证 exclude：把促销规则改成"排除促销日" → 促销日不再命中
	db.transaction((tx) => {
		const rule = tx.rules.findOne((r) => r.name === "促销规则");
		tx.rules.updateOne(rule._id, { includeCalendars: [], excludeCalendars: [calId] });
	});
	const excluded = resolvePricing("deepseek-flash", "deepseek", PEAK, p);
	assert.equal(excluded.output, 8, "促销日被排除 → 回到峰价");
	rmSync(dir, { recursive: true, force: true });
});

test("resolve：createPricingResolver 批量闭包（含数字时间戳与兜底）", () => {
	const resolver = createPricingResolver(SEED_PATH);
	assert.equal(resolver("deepseek-flash", "deepseek", PEAK).output, 8);
	assert.equal(resolver("deepseek-flash", "deepseek", IDLE).output, 4);
	assert.equal(resolver("deepseek-flash", "deepseek", PEAK.getTime()).output, 8, "数字时间戳应支持");
	assert.equal(resolver("unknown", "deepseek", PEAK).output, 4, "未知模型兜底");
});

test("resolve：种子默认数据自洽（每条规则的 rateId 可解析）", () => {
	const resolver = createPricingResolver(SEED_PATH);
	for (const model of DEFAULT_PRICING.models) {
		const price = resolver(model.model, model.provider, PEAK);
		assert.ok(price.output > 0, `${model.provider}/${model.model} 应解析出价格`);
	}
});
