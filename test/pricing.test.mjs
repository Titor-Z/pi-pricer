/**
 * pi-pricer v2 核心逻辑测试：store（含迁移）+ query（resolution）+ format + builder + drawer + commands。
 *
 * 使用临时目录隔离文件 IO，不污染真实 ~/.pi/。
 * jiti 直载 src/*.ts（.mjs 禁写 TS 语法）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const SRC = "/Users/titor/projects/pi-pricer/src";

// getSettingsListTheme 依赖全局主题单例，先初始化（dark 兜底即可）
const { initTheme } = await jiti.import("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
initTheme("dark");

const { readPricing, writePricing, seedPricing, updatePricing, migrateV1ToV2, checkPlanDeletable, checkPriceDeletable } = await jiti.import(`${SRC}/pricing-store.ts`);
const { resolvePricing, createPricingResolver, resolveDebug, listProviderModels, listProviders } = await jiti.import(`${SRC}/pricing-query.ts`);
const {
	renderPriceList, renderModelDetail, renderSchema, renderPlanList, renderPlanDetail,
	renderPriceRegistry, renderCalendarList, renderResolveResult, renderHelp,
} = await jiti.import(`${SRC}/pricing-format.ts`);
const { listProviderRows, listModelRows } = await jiti.import(`${SRC}/pricing-builder.ts`);
const { PricingDrawer } = await jiti.import(`${SRC}/pricing-ui.ts`);
const { PricingCommands } = await jiti.import(`${SRC}/pricing-commands.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-"));
}

// ── v2 fixture ──────────────────────────────────────────────────────────
// deepseek：工作日高峰（峰价）+ 全时谷价；glm：单 always
const FIXTURE = {
	version: 2,
	calendars: { holidays: { name: "节假日", dates: ["2026-01-01", "2026-09-15"] } },
	prices: {
		peak: { name: "峰价", input: { miss: 2, hit: 0.04 }, output: 8 },
		valley: { name: "谷价", input: { miss: 1, hit: 0.02 }, output: 4 },
		glm: { name: "GLM 标准", input: { miss: 0.8, hit: 0.23 }, output: 2.8 },
	},
	plans: {
		peakworkday: {
			name: "工作日高峰",
			rules: [{
				schedule: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [["09:00", "12:00"], ["14:00", "18:00"]] },
				price: "peak",
			}],
		},
		valleyalways: {
			name: "全时谷价",
			rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: "valley" }],
		},
		glmalways: {
			name: "GLM 全时",
			rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: "glm" }],
		},
	},
	providers: {
		deepseek: {
			models: {
				"deepseek-flash": {
					alias: "deepseek-v4-flash",
					plans: [
						{ plan: "peakworkday", enabled: true },
						{ plan: "valleyalways", enabled: true },
					],
				},
			},
		},
		glm: { models: { "glm-5.3-flash": { plans: [{ plan: "glmalways", enabled: true }] } } },
	},
};

// 时间基线：北京 UTC+8
// 2026-09-15 周二 02:00Z = 北京 10:00（峰窗） ／ 2026-09-19 周六未用
/** 周二峰时 10:00 北京 */
const PEAK_TS = new Date("2026-09-15T02:00:00Z");
/** 周四空闲 21:00 北京 */
const IDLE_TS = new Date("2026-09-17T13:00:00Z");
/** 周日整天 */
const SUN_TS = new Date("2026-09-20T04:00:00Z");
/** 节假日当天（9-15 在日历里）峰窗 10:00 北京 */
const HOLIDAY_TS = new Date("2026-09-15T02:00:00Z");

// ── store ────────────────────────────────────────────────────────────────

test("store：文件不存在时返回 v2 内置默认值", () => {
	const dir = tmpDir();
	const data = readPricing(join(dir, "nonexistent.json"));
	assert.equal(data.version, 2);
	assert.ok("deepseek" in data.providers);
	assert.ok("deepseek-peak" in data.prices, "应有峰价实体");
	rmSync(dir, { recursive: true, force: true });
});

test("store：写入后读回一致（v2 五注册表）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const back = readPricing(path);
	assert.deepEqual(back, FIXTURE);
	rmSync(dir, { recursive: true, force: true });
});

test("store：JSON 损坏时回退 v2 默认值", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writeFileSync(path, "{bad json", "utf8");
	const data = readPricing(path);
	assert.equal(data.version, 2);
	assert.ok("deepseek" in data.providers);
	rmSync(dir, { recursive: true, force: true });
});

test("store：seedPricing 首次写入，已存在 v2 不覆盖；v1 文件主动迁移写回", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const first = readPricing(path);
	assert.equal(first.version, 2);
	// 已存在 v2 → 再 seed 不覆盖
	writePricing(FIXTURE, path);
	seedPricing(path);
	assert.ok("glm" in readPricing(path).providers);
	// v1 文件 → seed 主动迁移落盘 v2
	const v1 = { version: 1, providers: { deepseek: { peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12]] }, models: { flash: { alias: "a1", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } } } } } };
	writeFileSync(path, JSON.stringify(v1), "utf8");
	seedPricing(path);
	const migrated = readPricing(path);
	assert.equal(migrated.version, 2);
	assert.ok("deepseek-peak" in migrated.prices);
	rmSync(dir, { recursive: true, force: true });
});

test("store：updatePricing 原子修改（按注入路径）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const updated = updatePricing((data) => {
		data.prices.custom = { name: "自定义", input: { miss: 1, hit: 1 }, output: 1 };
		return data;
	}, path);
	assert.ok("custom" in updated.prices);
	assert.ok("custom" in readPricing(path).prices);
	rmSync(dir, { recursive: true, force: true });
});

test("store：migrateV1ToV2 有峰 → peak/valley 两方案 + 两价格实体", () => {
	const v1 = {
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: { "deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } } },
			},
		},
	};
	const out = migrateV1ToV2(v1);
	assert.equal(out.version, 2);
	assert.ok("deepseek-peak" in out.prices && "deepseek-valley" in out.prices);
	const flash = out.providers.deepseek.models["deepseek-flash"];
	assert.equal(flash.alias, "deepseek-v4-flash");
	assert.equal(flash.plans.length, 2);
	// 峰价输入沿用 v1 谷输入（v1 未存峰输入价）
	assert.equal(out.prices["deepseek-peak"].input.miss, 1);
	assert.equal(out.prices["deepseek-peak"].output, 8);
	assert.equal(out.prices["deepseek-valley"].output, 4);
	// 方案 schedule 由 v1 peakHours 生成
	assert.deepEqual(out.plans["deepseek-peak-plan"].rules[0].schedule.ranges, [["09:00", "12:00"], ["14:00", "18:00"]]);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("store：migrateV1ToV2 多模型不同价各自独立、同价共享方案（真实文件形态）", () => {
	const v1 = {
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
					"deepseek-v4-pro": { input: { miss: 4.5, hit: 0.15 }, output: { standard: 13.5, peak: 27 } },
					"deepseek-flash-dupe": { input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	};
	const out = migrateV1ToV2(v1);
	assert.equal(out.prices["deepseek-peak"].output, 8);
	assert.equal(out.prices["deepseek-valley"].output, 4);
	assert.equal(out.prices["deepseek-peak1"].output, 27, "pro 独立峰价实体");
	assert.equal(out.prices["deepseek-valley1"].output, 13.5, "pro 独立谷价实体");
	assert.equal(out.prices["deepseek-peak1"].input.miss, 4.5, "pro 峰输入沿用 v1 谷输入");
	const flash = out.providers.deepseek.models["deepseek-flash"];
	const dupe = out.providers.deepseek.models["deepseek-flash-dupe"];
	const pro = out.providers.deepseek.models["deepseek-v4-pro"];
	assert.deepEqual(flash.plans, dupe.plans, "同价模型共享同一组方案");
	assert.ok(pro.plans[0].plan === "deepseek-peak-plan1", "pro 绑定独立峰方案");
	// 写盘后用解析器验证 flash=谷4 峰8、pro=谷13.5 峰27
	const p = join(tmpDir(), "mig.json");
	writePricing(out, p);
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, p).output, 8);
	assert.equal(resolvePricing("deepseek-flash", "deepseek", IDLE_TS, p).output, 4);
	assert.equal(resolvePricing("deepseek-v4-pro", "deepseek", PEAK_TS, p).output, 27);
	assert.equal(resolvePricing("deepseek-v4-pro", "deepseek", IDLE_TS, p).output, 13.5);
	assert.equal(resolvePricing("deepseek-v4-pro", "deepseek", PEAK_TS, p).inputMiss, 4.5);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("store：migrateV1ToV2 无峰 → 单 always 方案", () => {
	const v1 = {
		version: 1,
		providers: {
			glm: { peakHours: null, models: { "glm-5.3-flash": { input: { miss: 0.8, hit: 0.23 }, output: { standard: 2.8, peak: null } } } },
		},
	};
	const out = migrateV1ToV2(v1);
	assert.ok("glm-standard" in out.prices);
	assert.equal(out.providers.glm.models["glm-5.3-flash"].plans.length, 1);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("store：删除引用保护（方案/价格被引用时拒绝）", () => {
	assert.equal(checkPlanDeletable(FIXTURE, "peakworkday").ok, false);
	assert.equal(checkPlanDeletable(FIXTURE, "不存在").ok, true);
	assert.equal(checkPriceDeletable(FIXTURE, "peak").ok, false);
	assert.equal(checkPriceDeletable(FIXTURE, "不存在").ok, true);
});

// ── query：resolution ────────────────────────────────────────────────────

function writeFixture(dir) {
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	return path;
}

test("query：谷时段 → 谷价（isPeak=false）", () => {
	const path = writeFixture(tmpDir());
	const r = resolvePricing("deepseek-flash", "deepseek", IDLE_TS, path);
	assert.equal(r.output, 4);
	assert.equal(r.inputMiss, 1);
	assert.equal(r.inputHit, 0.02);
	assert.equal(r.isPeak, false);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：alias 匹配（deepseek-v4-flash）", () => {
	const path = writeFixture(tmpDir());
	const r = resolvePricing("deepseek-v4-flash", "deepseek", IDLE_TS, path);
	assert.equal(r.output, 4);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：峰时段 → 峰价（含峰输入价）", () => {
	const path = writeFixture(tmpDir());
	const r = resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(r.output, 8);
	assert.equal(r.inputMiss, 2, "峰时输入 miss 翻倍");
	assert.equal(r.inputHit, 0.04);
	assert.equal(r.isPeak, true);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：周末 → 谷价", () => {
	const path = writeFixture(tmpDir());
	const r = resolvePricing("deepseek-flash", "deepseek", SUN_TS, path);
	assert.equal(r.output, 4);
	assert.equal(r.isPeak, false);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：绑定 enabled=false 跳过（峰时也只用剩余方案）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.providers.deepseek.models["deepseek-flash"].plans[0].enabled = false;
	writePricing(f, path);
	const r = resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(r.output, 4, "峰方案禁用 → 落谷价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：绑定顺序 first-match wins（谷价置前 → 峰时也命中谷）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.providers.deepseek.models["deepseek-flash"].plans = [
		{ plan: "valleyalways", enabled: true },
		{ plan: "peakworkday", enabled: true },
	];
	writePricing(f, path);
	const r = resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(r.output, 4, "always 前置 → first match 命中谷价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：规则 validUntil 过期 → 不参与匹配", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.plans.peakworkday.rules[0].validUntil = "2026-01-01";
	writePricing(f, path);
	const r = resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(r.output, 4, "9-15 已过有效期 → 谷价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：includeDates 覆盖周规则（周末也命中）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.plans.peakworkday.rules[0].schedule.includeDates = ["2026-09-19"];
	writePricing(f, path);
	// 09-19 周六 10:00 北京 → includeDates 命中
	const r = resolvePricing("deepseek-flash", "deepseek", new Date("2026-09-19T02:00:00Z"), path);
	assert.equal(r.output, 8, "includeDates 让周六也走峰价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：excludeDates 剔除（周一峰窗内被排除 → 谷价）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.plans.peakworkday.rules[0].schedule.excludeDates = ["2026-09-15"];
	writePricing(f, path);
	const r = resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(r.output, 4, "excludeDates 剔除峰窗 → 谷价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：日历 exclude（节假日当天不按周规则峰价）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	// 9-15 在 holidays 日历中；peakworkday 排除节假日
	f.plans.peakworkday.rules[0].schedule.calendar = "holidays";
	f.plans.peakworkday.rules[0].schedule.calendarMode = "exclude";
	writePricing(f, path);
	const r = resolvePricing("deepseek-flash", "deepseek", HOLIDAY_TS, path);
	assert.equal(r.output, 4, "日历 exclude → 节假日窗口不峰价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：日历 include（仅在节假日定价）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.plans.holidayonly = { name: "仅节假日峰价", rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [], calendar: "holidays", calendarMode: "include" }, price: "peak" }] };
	f.providers.deepseek.models["deepseek-flash"].plans.unshift({ plan: "holidayonly", enabled: true });
	writePricing(f, path);
	// 9-15（日历内）= 峰价；9-17（不在日历）= 谷价
	assert.equal(resolvePricing("deepseek-flash", "deepseek", HOLIDAY_TS, path).output, 8);
	assert.equal(resolvePricing("deepseek-flash", "deepseek", IDLE_TS, path).output, 4);
	rmSync(dir, { recursive: true, force: true });
});

test("query：glm 单 always 方案恒用标准价", () => {
	const path = writeFixture(tmpDir());
	assert.equal(resolvePricing("glm-5.3-flash", "glm", PEAK_TS, path).output, 2.8);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：未知模型/厂商 → 兜底价", () => {
	const path = writeFixture(tmpDir());
	const r = resolvePricing("unknown", "unknown", PEAK_TS, path);
	assert.equal(r.output, 4);
	assert.equal(r.inputMiss, 1);
	assert.equal(r.isPeak, false);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：createPricingResolver 批量闭包（峰/谷/alias/数字时间戳/兜底）", () => {
	const path = writeFixture(tmpDir());
	const pricing = createPricingResolver(path);
	assert.equal(pricing("deepseek-flash", "deepseek", PEAK_TS).output, 8);
	assert.equal(pricing("deepseek-flash", "deepseek", IDLE_TS).output, 4);
	assert.equal(pricing("deepseek-v4-flash", "deepseek", IDLE_TS).inputHit, 0.02);
	assert.equal(pricing("deepseek-flash", "deepseek", IDLE_TS.getTime()).output, 4);
	assert.equal(pricing("nope", "deepseek", PEAK_TS).output, 4);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：resolveDebug 命中链（峰时 → 链尾命中峰规则）", () => {
	const path = writeFixture(tmpDir());
	const d = resolveDebug("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.equal(d.matched, true);
	assert.equal(d.chain.length, 1, "首规则即命中，链到命中即止");
	assert.equal(d.chain[0].planName, "工作日高峰");
	assert.equal(d.chain[0].matched, true);
	assert.equal(d.price.output, 8);
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("query：resolveDebug 未命中链（仅峰方案的模型在周末 → 兜底）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	f.providers.deepseek.models["deepseek-flash"].plans = [{ plan: "peakworkday", enabled: true }];
	writePricing(f, path);
	const d = resolveDebug("deepseek-flash", "deepseek", SUN_TS, path);
	assert.equal(d.matched, false);
	assert.equal(d.chain.length, 1);
	assert.equal(d.chain[0].matched, false);
	assert.ok(d.chain[0].reason.includes("不在"), "未命中要带原因");
	assert.equal(d.price.output, 4, "兜底价");
	rmSync(dir, { recursive: true, force: true });
});

test("query：listProviders / listProviderModels", () => {
	const path = writeFixture(tmpDir());
	assert.deepEqual(listProviders(path).sort(), ["deepseek", "glm"]);
	const infos = listProviderModels("deepseek", undefined, path);
	assert.equal(infos.length, 1);
	assert.equal(infos[0].model, "deepseek-flash");
	assert.equal(infos[0].alias, "deepseek-v4-flash");
	assert.deepEqual(infos[0].planBindings.map((b) => b.planName), ["工作日高峰", "全时谷价"]);
	assert.equal(typeof infos[0].livePrice.output, "number");
	rmSync(tmpDir(), { recursive: true, force: true });
});

// ── format ───────────────────────────────────────────────────────────────

test("format：renderPriceList 含厂商/模型/谷峰两档/基准标记/实时生效", () => {
	const path = writeFixture(tmpDir());
	const text = renderPriceList(path);
	assert.ok(text.includes("deepseek"));
	assert.ok(text.includes("deepseek-flash (aka deepseek-v4-flash)"));
	assert.ok(text.includes("输出 ¥4.00"), "谷档价目");
	assert.ok(text.includes("输出 ¥8.00"), "峰档价目");
	assert.ok(text.includes("输入 未缓存 ¥2.00"), "峰输入价");
	assert.ok(text.includes("←基准"), "always 规则标基准");
	assert.ok(text.includes("当前生效"), "实时生效行");
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("format：renderModelDetail 含别名/绑定方案/当前生效/编辑提示", () => {
	const path = writeFixture(tmpDir());
	const text = renderModelDetail("deepseek", "deepseek-flash", path);
	assert.ok(text.includes("deepseek/deepseek-flash"));
	assert.ok(text.includes("别名: deepseek-v4-flash"));
	assert.ok(text.includes("绑定方案"));
	assert.ok(text.includes("当前生效"));
	assert.ok(text.includes("编辑"));
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("format：renderSchema 说明 v2 五注册表与语义", () => {
	const text = renderSchema();
	assert.ok(text.includes("Schema v2"));
	assert.ok(text.includes("plans"));
	assert.ok(text.includes("prices"));
	assert.ok(text.includes("calendars"));
	assert.ok(text.includes("first match wins"));
});

test("format：renderPlanList / renderPlanDetail / renderPriceRegistry / renderCalendarList", () => {
	const path = writeFixture(tmpDir());
	assert.ok(renderPlanList(path).includes("工作日高峰"));
	assert.ok(renderPlanDetail("peakworkday", path).includes("9"));
	assert.ok(renderPlanDetail("none", path).includes("未找到方案"));
	assert.ok(renderPriceRegistry(path).includes("峰价"), "价格实体注册表含价目");
	assert.ok(renderPriceRegistry(path).includes("被引用: peakworkday"), "注册表标注被引用方案");
	assert.ok(renderCalendarList(path).includes("holidays"));
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("format：renderResolveResult 命中链与兜底链", () => {
	const path = writeFixture(tmpDir());
	const hit = renderResolveResult("deepseek-flash", "deepseek", PEAK_TS, path);
	assert.ok(hit.includes("✓ 命中"));
	assert.ok(hit.includes("输出 ¥8.00"));
	const bare = structuredClone(FIXTURE);
	// 无兜底 always → 周末 fallback
	const dir = tmpDir();
	const p2 = join(dir, "p2.json");
	bare.providers.deepseek.models["deepseek-flash"].plans = [{ plan: "peakworkday", enabled: true }];
	writePricing(bare, p2);
	const miss = renderResolveResult("deepseek-flash", "deepseek", SUN_TS, p2);
	assert.ok(miss.includes("✗ 未中"));
	assert.ok(miss.includes("兜底价"));
	rmSync(dir, { recursive: true, force: true });
});

test("format：renderHelp 含主要子命令", () => {
	const t = renderHelp();
	assert.ok(t.includes("/price resolve"));
	assert.ok(t.includes("/price plan"));
	assert.ok(t.includes("/price bind"));
});

// ── builder 纯函数 ──────────────────────────────────────────────────────

test("builder：listProviderRows 列出厂商与方案摘要", () => {
	const path = writeFixture(tmpDir());
	const rows = listProviderRows(path);
	assert.equal(rows.length, 2);
	const ds = rows.find((r) => r.providerId === "deepseek");
	assert.equal(ds.modelCount, 1);
	assert.ok(ds.planDesc.includes("工作日高峰"));
	assert.ok(ds.description.includes("周一至周五"));
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("builder：listModelRows 实时价与绑定数；未知厂商空数组", () => {
	const path = writeFixture(tmpDir());
	const rows = listModelRows("deepseek", path);
	assert.equal(rows.length, 1);
	const flash = rows[0];
	assert.equal(flash.modelId, "deepseek-flash");
	assert.equal(flash.alias, "deepseek-v4-flash");
	assert.equal(flash.boundCount, 2);
	assert.equal(flash.enabledCount, 2);
	assert.ok(/¥[48]\.00/.test(flash.liveOutput), "实时输出价应为 4 或 8");
	assert.equal(listModelRows("nope", path).length, 0);
	rmSync(tmpDir(), { recursive: true, force: true });
});

// ── 抽屉（PricingDrawer）───────────────────────────────────────────────

function drawerCtx() {
	const ctx = {};
	const captured = {};
	ctx.captured = captured;
	ctx.ui = { custom: async (factory) => { captured.factory = factory; } };
	return ctx;
}

function runDrawer(captured) {
	assert.ok(captured.factory, "应调用 ctx.ui.custom 开抽屉");
	const theme = { fg: (color, text) => text, bold: (text) => text };
	let doneCount = 0;
	const handle = captured.factory({}, theme, {}, () => { doneCount += 1; });
	handle.doneCount = () => doneCount;
	return handle;
}

function plainOf(handle, width = 100) {
	return handle.render(width).join("\n").replace(/\u001b\[\d+(;\d+)*m/g, "");
}

test("抽屉：headless（无 custom UI）返回 false", async () => {
	const ctx = { ui: {} };
	const opened = await new PricingDrawer().open(ctx);
	assert.equal(opened, false);
});

test("抽屉：捕获工厂渲染厂商列表（v2 方案摘要）", async () => {
	const path = writeFixture(tmpDir());
	const ctx = drawerCtx();
	assert.equal(await new PricingDrawer(path).open(ctx), true);
	const out = plainOf(runDrawer(ctx.captured));
	assert.ok(out.includes("模型计费配置 · 厂商"));
	assert.ok(out.includes("deepseek"));
	assert.ok(out.includes("glm"));
	assert.ok(out.includes("工作日高峰"));
	rmSync(tmpDir(), { recursive: true, force: true });
});

test("抽屉：Enter 下钻 → 模型行 → 详情页 → Esc 返回闭环", async () => {
	const path = writeFixture(tmpDir());
	const ctx = drawerCtx();
	await new PricingDrawer(path).open(ctx);
	const handle = runDrawer(ctx.captured);

	handle.handleInput("\r");
	const level1 = plainOf(handle);
	assert.ok(level1.includes("deepseek-flash"), "应显示模型列表");
	assert.ok(level1.includes("档启用"), "模型行显示绑定启用数");
	assert.ok(level1.includes("模型计费配置 · deepseek"), "标题应更新为厂商层级");

	handle.handleInput("\x1b");
	assert.ok(plainOf(handle).includes("模型计费配置 · 厂商"), "Esc 返回厂商列表");

	handle.handleInput("\r");
	handle.handleInput("\r");
	const detail = plainOf(handle);
	assert.ok(detail.includes("deepseek-flash"), "详情页列出模型绑定");
	assert.ok(detail.includes("绑定新方案"), "提供追加绑定入口");

	// 进入只读详情页（Enter 到最后一项）
	handle.handleInput("\x1b[F");
	handle.handleInput("\r");
	const readonlyPage = plainOf(handle);
	assert.ok(readonlyPage.includes("deepseek/deepseek-flash"), "只读详情页含模型路径");

	handle.handleInput("\x1b");
	const back1 = plainOf(handle);
	assert.ok(back1.includes("deepseek-flash"), "Esc 返回模型详情菜单");
	rmSync(tmpDir(), { recursive: true, force: true });
});

// ── /price 命令接线 ─────────────────────────────────────────────────────

function cmdCtx({ withCustom = true } = {}) {
	const notifications = [];
	const captured = {};
	return {
		ui: {
			notify: (text) => notifications.push(text),
			custom: async (factory) => { captured.factory = factory; },
		},
		notifications,
		captured,
		withCustom,
	};
}

function cmdPi() {
	const commands = new Map();
	return { registerCommand: (name, options) => commands.set(name, options), commands };
}

function mountAt(path) {
	const pi = cmdPi();
	const mounted = new PricingCommands(path);
	mounted.mount(pi);
	return { pi, handler: pi.commands.get("price").handler };
}

test("挂载：/price 无参 TUI 开抽屉；headless 回退文本总览", async () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const { handler } = mountAt(path);
	const tui = cmdCtx({ withCustom: true });
	await handler("", tui);
	assert.ok(tui.captured.factory, "TUI 开抽屉");
	const headless = cmdCtx({ withCustom: false });
	headless.ui = { notify: headless.ui.notify };
	await handler("", headless);
	assert.ok(headless.notifications.some((t) => t.includes("deepseek")), "headless 通知总览");
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price bind 追加末尾（最低优先级）→ 绑定数+1 / 谷仍生效；unbind 回退", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const f = structuredClone(FIXTURE);
	// deepseek-flash 只绑谷价
	f.providers.deepseek.models["deepseek-flash"].plans = [{ plan: "valleyalways", enabled: true }];
	writePricing(f, path);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };
	const modelPlans = () => listProviderModels("deepseek", undefined, path)[0].planBindings.length;

	assert.equal(modelPlans(), 1);
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4);
	await handler("bind deepseek deepseek-flash peakworkday", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已绑定"));
	assert.equal(modelPlans(), 2, "bind 追加绑定");
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4, "追加在末尾=最低优先级，谷 always 仍 first-match");

	ctx.notifications.length = 0;
	await handler("unbind deepseek deepseek-flash peakworkday", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已解除"));
	assert.equal(modelPlans(), 1, "unbind 移除绑定");
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4);
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price price set 修改实体 → resolve 反映；删除被引用价格被拒", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	await handler("price set peak output 9", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已修改价格"));
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 9);

	ctx.notifications.length = 0;
	await handler("price delete peak", ctx);
	assert.ok(ctx.notifications.at(-1).includes("仍被方案"), "被引用的价格应拒绝删除");
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price resolve 输出命中链；/price plan 输出清单列表", async () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	await handler("resolve deepseek-flash deepseek 2026-09-15T02:00:00Z", ctx);
	const hitText = ctx.notifications.at(-1);
	assert.ok(hitText.includes("命中"), "resolve 应输出命中链");

	ctx.notifications.length = 0;
	await handler("plan", ctx);
	assert.ok(ctx.notifications.at(-1).includes("工作日高峰"), "plan 列表含方案名");

	ctx.notifications.length = 0;
	await handler("bogus", ctx);
	assert.ok(ctx.notifications.at(-1).includes("/price resolve"), "未知子命令给 help");
	rmSync(dir, { recursive: true, force: true });
});
// ── v0.5 编辑面（PricingDraft）───────────────────────────────────────────

const { PricingDraft } = await jiti.import(`${SRC}/pricing-draft.ts`);
const { listProviderPlans } = await jiti.import(`${SRC}/pricing-builder.ts`);

test("draft：变更写入内存，未 save 时磁盘不变", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	assert.equal(draft.isDirty, false, "初始无改动");

	draft.toggleBinding("deepseek", "deepseek-flash", "peakworkday");
	assert.equal(draft.isDirty, true, "切换后应标记为脏");
	assert.deepEqual(draft.changedAreas, ["模型"]);

	// 未 save：磁盘仍是原值（峰时仍是峰价 8）
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8, "未保存时磁盘不变");
	rmSync(dir, { recursive: true, force: true });
});

test("draft：save 全量落盘后 resolve 反映改动", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	draft.toggleBinding("deepseek", "deepseek-flash", "peakworkday");
	const result = draft.save();

	assert.equal(result.ok, true);
	assert.equal(draft.isDirty, false, "保存后脏标记应清空");
	// 禁用峰方案后，峰时回落到谷价 4
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4, "禁用峰后峰时走谷价");
	rmSync(dir, { recursive: true, force: true });
});

test("draft：reset 丢弃未保存改动", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	draft.setPriceField("peak", "output", 99);
	assert.equal(draft.isDirty, true);
	draft.reset();
	assert.equal(draft.isDirty, false, "reset 后不应有改动");
	assert.equal(draft.snapshot().prices.peak.output, 8, "内存态恢复原值");
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8, "磁盘未被污染");
	rmSync(dir, { recursive: true, force: true });
});

test("draft：删除被绑定方案时 save 被拒且不落盘", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	draft.deletePlan("peakworkday");
	const result = draft.save();

	assert.equal(result.ok, false, "仍被绑定的方案应拒绝保存");
	assert.ok(result.reason.includes("peakworkday"), "拒绝原因应指明方案");
	// 磁盘仍是原状（峰价 8 生效）
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8, "拒绝时不得落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("draft：绑定增删与别名设置", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	assert.equal(draft.removeBinding("deepseek", "deepseek-flash", "valleyalways"), true);
	assert.equal(draft.snapshot().providers.deepseek.models["deepseek-flash"].plans.length, 1);

	assert.equal(draft.addBinding("deepseek", "deepseek-flash", "valleyalways"), true);
	const plans = draft.snapshot().providers.deepseek.models["deepseek-flash"].plans;
	assert.equal(plans.at(-1).plan, "valleyalways", "追加应落在末尾（最低优先级）");

	assert.equal(draft.setAlias("deepseek", "deepseek-flash", "ds-flash"), true);
	assert.equal(draft.snapshot().providers.deepseek.models["deepseek-flash"].alias, "ds-flash");
	draft.setAlias("deepseek", "deepseek-flash", "");
	assert.equal(draft.snapshot().providers.deepseek.models["deepseek-flash"].alias, undefined, "空串应清除别名");
	rmSync(dir, { recursive: true, force: true });
});

test("draft：方案复制与至少保留一条规则", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);

	const draft = new PricingDraft(path);
	const newId = draft.duplicatePlan("valleyalways");
	assert.equal(newId, "valleyalways-copy");
	assert.ok(draft.snapshot().plans[newId].name.includes("副本"));

	// 单规则方案不允许删除最后一条
	assert.equal(draft.removeRule("valleyalways-copy", 0), false, "至少保留一条规则");
	assert.equal(draft.addRule("valleyalways-copy"), true);
	assert.equal(draft.snapshot().plans["valleyalways-copy"].rules.length, 2);
	rmSync(dir, { recursive: true, force: true });
});

test("draft：listProviderPlans 列出全部方案", () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const plans = listProviderPlans(path);
	assert.equal(plans.length, 3);
	assert.ok(plans.some((p) => p.id === "peakworkday" && p.name === "工作日高峰"));
	rmSync(dir, { recursive: true, force: true });
});

// ── v0.5 CLI：/price move 绑定优先级 ─────────────────────────────────────

test("挂载：/price move 上移绑定 → 优先级改变（first match wins）", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	// 默认：peakworkday 在前 → 峰时 8
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8);

	// 把 valleyalways 移到最前
	await handler("move deepseek deepseek-flash valleyalways top", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已移动"));

	const order = JSON.parse(readFileSync(path, "utf8"))
		.providers.deepseek.models["deepseek-flash"].plans.map((b) => b.plan);
	assert.deepEqual(order, ["valleyalways", "peakworkday"], "谷价方案应排到最前");
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4, "谷价优先后峰时也给谷价");

	// 再 down 移回
	await handler("move deepseek deepseek-flash valleyalways down", ctx);
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8, "下移后峰价恢复");
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price move 越界不破坏数据；无效方向被拒", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	// up 已在最前：空操作 + 提示
	await handler("move deepseek deepseek-flash peakworkday up", ctx);
	assert.ok(ctx.notifications.at(-1).includes("最高优先级"), "应提示已在最高优先级");

	ctx.notifications.length = 0;
	await handler("move deepseek deepseek-flash peakworkday sideways", ctx);
	assert.ok(ctx.notifications.at(-1).includes("无效方向"), "无效方向应被拒");

	ctx.notifications.length = 0;
	await handler("move deepseek deepseek-flash nonexistent up", ctx);
	assert.ok(ctx.notifications.at(-1).includes("未绑定"), "未绑定方案应报错");

	// 数据未被破坏
	const order = JSON.parse(readFileSync(path, "utf8"))
		.providers.deepseek.models["deepseek-flash"].plans.map((b) => b.plan);
	assert.deepEqual(order, ["peakworkday", "valleyalways"]);
	rmSync(dir, { recursive: true, force: true });
});

// ── v0.5 CLI：管理面 CRUD ────────────────────────────────────────────────

test("挂载：/price plan create|duplicate|delete", async () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	await handler("plan create myplan 我的方案", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已新建方案 myplan"));
	assert.ok(readPricing(path).plans.myplan, "方案应写入");
	assert.equal(readPricing(path).plans.myplan.rules.length, 1, "默认挂一条规则");

	ctx.notifications.length = 0;
	await handler("plan duplicate myplan", ctx);
	assert.ok(ctx.notifications.at(-1).includes("myplan-copy"));
	assert.ok(readPricing(path).plans["myplan-copy"]);

	ctx.notifications.length = 0;
	await handler("plan delete myplan-copy", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已删除方案"));
	assert.equal(readPricing(path).plans["myplan-copy"], undefined);

	// 被绑定的方案拒绝删除
	ctx.notifications.length = 0;
	await handler("plan delete peakworkday", ctx);
	assert.ok(ctx.notifications.at(-1).includes("仍被"), "被绑定方案应拒绝删除");
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price calendar add|remove 与被引用保护", async () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	await handler("calendar add promo 促销日 03-15 06-18", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已写入日历 promo"));
	assert.deepEqual(readPricing(path).calendars.promo.dates, ["03-15", "06-18"]);

	ctx.notifications.length = 0;
	await handler("calendar add bad 坏日期 2026-13", ctx);
	assert.ok(ctx.notifications.at(-1).includes("无效日期"), "坏日期应被拒");

	// 引用了日历的方案 → 删除该引用方案前，日历不可删
	ctx.notifications.length = 0;
	await handler("plan delete peakworkday", ctx);  // 先解除对日历的潜在引用（此处无引用，故成功）
	await handler("plan create calplan 日历方案", ctx);
	updatePricing((data) => {
		data.plans.calplan.rules[0].schedule.calendar = "promo";
		return data;
	}, path);
	ctx.notifications.length = 0;
	await handler("calendar remove promo", ctx);
	assert.ok(ctx.notifications.at(-1).includes("仍被方案"), "被引用日历应拒绝删除");

	// 解除引用后可删
	updatePricing((data) => {
		delete data.plans.calplan.rules[0].schedule.calendar;
		return data;
	}, path);
	ctx.notifications.length = 0;
	await handler("calendar remove promo", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已删除日历 promo"));
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price price create", async () => {
	const dir = tmpDir();
	const path = writeFixture(dir);
	const { handler } = mountAt(path);
	const ctx = cmdCtx({ withCustom: false });
	ctx.ui = { notify: ctx.ui.notify };

	await handler("price create myprice 我的价格", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已新建价格 myprice"));
	assert.equal(readPricing(path).prices.myprice.output, 0, "初始价为 0");

	ctx.notifications.length = 0;
	await handler("price create myprice", ctx);
	assert.ok(ctx.notifications.at(-1).includes("已存在"), "重复创建应被拒");
	rmSync(dir, { recursive: true, force: true });
});

// ── v0.5 抽屉编辑闭环 ───────────────────────────────────────────────────

test("抽屉：详情页可编辑（绑定操作子菜单）", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const ctx = drawerCtx();
	await new PricingDrawer(path).open(ctx);
	const handle = runDrawer(ctx.captured);

	handle.handleInput("\r");        // 进入 deepseek
	handle.handleInput("\r");        // 进入 deepseek-flash 详情
	const detail = plainOf(handle);
	assert.ok(detail.includes("工作日高峰"), "详情页列出绑定方案");
	assert.ok(detail.includes("绑定新方案"), "提供增绑入口");
	assert.ok(detail.includes("别名"), "提供别名编辑入口");
	assert.ok(detail.includes("解析调试"), "提供解析调试入口");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：Ctrl+S 保存绑定改动到磁盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const ctx = drawerCtx();
	await new PricingDrawer(path).open(ctx);
	const handle = runDrawer(ctx.captured);

	handle.handleInput("\r");        // deepseek
	handle.handleInput("\r");        // deepseek-flash
	handle.handleInput("\r");        // 第一条绑定（peakworkday）
	const actions = plainOf(handle);
	assert.ok(actions.includes("禁用该绑定"), "绑定操作页应提供禁用");

	handle.handleInput("\r");        // 执行禁用（子菜单关闭，回到详情页）
	handle.handleInput("\x1b");      // 详情 -> 模型列表
	handle.handleInput("\x1b");      // 模型列表 -> 厂商列表（根层）
	const afterToggle = plainOf(handle);
	assert.ok(afterToggle.includes("未保存改动"), "应显示未保存状态");

	handle.handleInput("\u0013");    // Ctrl+S
	assert.ok(plainOf(handle).includes("已保存"), "保存后状态应变为已保存");

	// 磁盘生效：峰方案被禁用 → 峰时走谷价
	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 4, "Ctrl+S 后改动应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：Ctrl+R 丢弃未保存改动", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const ctx = drawerCtx();
	await new PricingDrawer(path).open(ctx);
	const handle = runDrawer(ctx.captured);

	handle.handleInput("\r");
	handle.handleInput("\r");
	handle.handleInput("\r");
	handle.handleInput("\r");        // 禁用第一条绑定
	handle.handleInput("\x1b");      // 回根层
	handle.handleInput("\x1b");
	assert.ok(plainOf(handle).includes("未保存改动"));

	handle.handleInput("\u0012");    // Ctrl+R
	const after = plainOf(handle);
	assert.ok(after.includes("已保存"), "重置后应显示已保存");
	assert.ok(after.includes("已丢弃"), "应提示已丢弃改动");

	assert.equal(resolvePricing("deepseek-flash", "deepseek", PEAK_TS, path).output, 8, "磁盘不应被改动");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：管理面入口（方案/价格/日历）可下钻", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing(FIXTURE, path);
	const ctx = drawerCtx();
	await new PricingDrawer(path).open(ctx);
	const handle = runDrawer(ctx.captured);

	const root = plainOf(handle);
	assert.ok(root.includes("方案注册表"), "根层应含方案注册表入口");
	assert.ok(root.includes("价格注册表"), "根层应含价格注册表入口");
	assert.ok(root.includes("日历注册表"), "根层应含日历注册表入口");

	// 下钻到方案注册表：根列表 = 2 厂商(deepseek, glm) + 方案/价格/日历 = 5 项
	// 从 deepseek 起 down 2 次到达「方案注册表」
	handle.handleInput("\u001b[B");  // down -> glm
	handle.handleInput("\u001b[B");  // down -> 方案注册表
	handle.handleInput("\r");
	const plansPage = plainOf(handle);
	assert.ok(plansPage.includes("工作日高峰"), "方案注册表应列出方案名");
	assert.ok(plansPage.includes("模型计费配置 · 方案"), "标题应更新为方案层级");
	rmSync(dir, { recursive: true, force: true });
});
