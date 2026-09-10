/**
 * pi-pricer 核心逻辑测试：store + query + format。
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

const { readPricing, writePricing, seedPricing, updatePricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { resolvePricing, listProviderModels, listProviders } = await jiti.import(`${SRC}/pricing-query.ts`);
const { renderPriceList, renderModelDetail, renderSchema } = await jiti.import(`${SRC}/pricing-format.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-"));
}

// ── store ────────────────────────────────────────────────────────────────

test("store：文件不存在时返回内置默认值", () => {
	const dir = tmpDir();
	const data = readPricing(join(dir, "nonexistent.json"));
	assert.equal(data.version, 1);
	assert.ok("deepseek" in data.providers);
	rmSync(dir, { recursive: true, force: true });
});

test("store：写入后读回一致", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const input = { version: 1, providers: {} };
	writePricing(input, path);
	const back = readPricing(path);
	assert.deepEqual(back, input);
	rmSync(dir, { recursive: true, force: true });
});

test("store：JSON 损坏时回退默认值", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writeFileSync(path, "{bad json", "utf8");
	const data = readPricing(path);
	assert.equal(data.version, 1);
	assert.ok("deepseek" in data.providers);
	rmSync(dir, { recursive: true, force: true });
});

test("store：seedPricing 首次写入，已存在不覆盖", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const first = readPricing(path);
	assert.equal(first.version, 1);
	// 修改后再 seed 不覆盖
	writePricing({ version: 1, providers: { custom: { peakHours: null, models: {} } } }, path);
	seedPricing(path);
	const second = readPricing(path);
	assert.ok("custom" in second.providers);
	rmSync(dir, { recursive: true, force: true });
});

test("store：updatePricing 原子修改", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const updated = updatePricing((data) => {
		data.providers.custom = { peakHours: null, models: {} };
		return data;
	}, path);
	assert.ok("custom" in updated.providers);
	const back = readPricing(path);
	assert.ok("custom" in back.providers);
	rmSync(dir, { recursive: true, force: true });
});

// ── query ────────────────────────────────────────────────────────────────

test("query：resolvePricing 精确匹配（空闲时段）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: null,
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	const r = resolvePricing("deepseek-flash", "deepseek", new Date("2026-09-10T21:00:00Z"), path);
	assert.equal(r.inputMiss, 1);
	assert.equal(r.inputHit, 0.02);
	assert.equal(r.output, 4); // 非峰
	assert.equal(r.isPeak, false);
	rmSync(dir, { recursive: true, force: true });
});

test("query：resolvePricing alias 匹配（deepseek-v4-flash → deepseek-flash）", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	const r = resolvePricing("deepseek-v4-flash", "deepseek", new Date("2026-09-10T21:00:00Z"), path);
	assert.equal(r.output, 4); // 非峰 → standard
	assert.equal(r.isPeak, false);
	rmSync(dir, { recursive: true, force: true });
});

test("query：resolvePricing 峰时段 → 输出价翻倍", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	// 2026-09-16 周二 02:00 UTC = 北京 10:00（9-12 区间内）→ 峰
	const r = resolvePricing("deepseek-flash", "deepseek", new Date("2026-09-16T02:00:00Z"), path);
	assert.equal(r.output, 8);
	assert.equal(r.inputMiss, 1);
	assert.equal(r.inputHit, 0.02);
	assert.equal(r.isPeak, true);
	rmSync(dir, { recursive: true, force: true });
});

test("query：resolvePricing 周末非峰", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	// 2026-09-20 周日 08:00 UTC = 北京 16:00（周末）
	const r = resolvePricing("deepseek-flash", "deepseek", new Date("2026-09-20T08:00:00Z"), path);
	assert.equal(r.output, 4); // 周末 → standard
	assert.equal(r.isPeak, false);
	rmSync(dir, { recursive: true, force: true });
});

test("query：resolvePricing output.peak=null → 恒用 standard", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			glm: {
				peakHours: null,
				models: {
					"glm-5.3-flash": { input: { miss: 0.8, hit: 0.23 }, output: { standard: 2.8, peak: null } },
				},
			},
		},
	}, path);
	const r = resolvePricing("glm-5.3-flash", "glm", new Date("2026-09-16T10:00:00Z"), path);
	assert.equal(r.output, 2.8);
	assert.equal(r.isPeak, false);
	rmSync(dir, { recursive: true, force: true });
});

test("query：resolvePricing 未知 model → 兜底价", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({ version: 1, providers: {} }, path);
	const r = resolvePricing("unknown-model", "unknown-provider", undefined, path);
	assert.equal(r.inputMiss, 1);
	assert.equal(r.inputHit, 0.02);
	assert.equal(r.output, 4);
	assert.equal(r.isPeak, false);
	rmSync(dir, { recursive: true, force: true });
});

test("query：listProviders 返回所有 provider id", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: { peakHours: null, models: { "deepseek-flash": { input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: null } } } },
			glm: { peakHours: null, models: { "glm-5.3-flash": { input: { miss: 0.8, hit: 0.23 }, output: { standard: 2.8, peak: null } } } },
		},
	}, path);
	const list = listProviders(path);
	assert.deepEqual(list.sort(), ["deepseek", "glm"]);
	rmSync(dir, { recursive: true, force: true });
});

test("query：listProviderModels 返回模型列表", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: null,
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	const models = listProviderModels("deepseek", undefined, path);
	assert.equal(models.length, 1);
	assert.equal(models[0].model, "deepseek-flash");
	assert.equal(models[0].alias, "deepseek-v4-flash");
	assert.equal(models[0].outputStandard, 4);
	assert.equal(models[0].outputPeak, 8);
	rmSync(dir, { recursive: true, force: true });
});

// ── format ───────────────────────────────────────────────────────────────

test("format：renderPriceList 包含所有厂商和模型", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	const text = renderPriceList(path);
	assert.ok(text.includes("deepseek"));
	assert.ok(text.includes("deepseek-flash"));
	assert.ok(text.includes("deepseek-v4-flash"));
	assert.ok(text.includes("¥4.00"));
	assert.ok(text.includes("¥8.00"));
	rmSync(dir, { recursive: true, force: true });
});

test("format：renderModelDetail 包含完整信息", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	writePricing({
		version: 1,
		providers: {
			deepseek: {
				peakHours: { timezone: "Asia/Shanghai", weekdays: [1, 2, 3, 4, 5], ranges: [[9, 12], [14, 18]] },
				models: {
					"deepseek-flash": { alias: "deepseek-v4-flash", input: { miss: 1, hit: 0.02 }, output: { standard: 4, peak: 8 } },
				},
			},
		},
	}, path);
	const text = renderModelDetail("deepseek", "deepseek-flash", path);
	assert.ok(text.includes("别名: deepseek-v4-flash"));
	assert.ok(text.includes("miss ¥1.00"));
	assert.ok(text.includes("hit ¥0.02"));
	assert.ok(text.includes("峰 ¥8.00"));
	rmSync(dir, { recursive: true, force: true });
});

test("format：renderSchema 返回 schema 说明", () => {
	const text = renderSchema();
	assert.ok(text.includes("Schema v1"));
	assert.ok(text.includes("peakHours"));
	assert.ok(text.includes("miss"));
	assert.ok(text.includes("hit"));
	assert.ok(text.includes("standard"));
	assert.ok(text.includes("peak"));
});

// ── 挂载集成测试 ────────────────────────────────────────────────────────

test("挂载：/price set 修改 JSON → list 反映新值", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	// 模拟 /price set deepseek deepseek-flash output.standard 99
	const updated = updatePricing((data) => {
		data.providers.deepseek.models["deepseek-flash"].output.standard = 99;
		return data;
	}, path);
	const r = resolvePricing("deepseek-flash", "deepseek", new Date("2026-09-10T21:00:00Z"), path);
	assert.equal(r.output, 99);
	// list 渲染包含新价格
	const text = renderPriceList(path);
	assert.ok(text.includes("¥99.00"));
	rmSync(dir, { recursive: true, force: true });
});
