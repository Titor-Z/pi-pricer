/**
 * pi-pricer 核心逻辑测试：store + query + format。
 *
 * 使用临时目录隔离文件 IO，不污染真实 ~/.pi/。
 * jiti 直载 src/*.ts（.mjs 禁写 TS 语法）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const SRC = "/Users/titor/projects/pi-pricer/src";

// getSettingsListTheme 依赖全局主题单例，先初始化（dark 兜底即可）
const { initTheme } = await jiti.import("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
initTheme("dark");

const { readPricing, writePricing, seedPricing, updatePricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { resolvePricing, createPricingResolver, listProviderModels, listProviders } = await jiti.import(`${SRC}/pricing-query.ts`);
const { renderPriceList, renderModelDetail, renderSchema } = await jiti.import(`${SRC}/pricing-format.ts`);
const { listProviderRows, listModelRows } = await jiti.import(`${SRC}/pricing-builder.ts`);
const { PricingDrawer } = await jiti.import(`${SRC}/pricing-ui.ts`);
const { PricingCommands } = await jiti.import(`${SRC}/pricing-commands.ts`);

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

test("query：createPricingResolver 一次读文件、逐条按峰谷解析", () => {
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
	const pricing = createPricingResolver(path);
	// 峰会时段（北京 10:00 2026-09-16 周二）→ 输出 8
	const peak = pricing("deepseek-flash", "deepseek", new Date("2026-09-16T02:00:00Z"));
	assert.equal(peak.output, 8);
	assert.equal(peak.isPeak, true);
	// 空闲（北京 21:00 周四）→ 输出 4；数字时间戳同样支持
	const idle = pricing("deepseek-flash", "deepseek", new Date("2026-09-10T13:00:00Z").getTime());
	assert.equal(idle.output, 4);
	assert.equal(idle.isPeak, false);
	// alias 匹配
	const alias = pricing("deepseek-v4-flash", "deepseek", new Date("2026-09-10T21:00:00Z"));
	assert.equal(alias.inputHit, 0.02);
	// 未知 → 兜底
	const fallback = pricing("nope", "deepseek", new Date("2026-09-10T21:00:00Z"));
	assert.equal(fallback.output, 4);
	assert.equal(fallback.inputMiss, 1);
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

// ── builder 纯函数 ──────────────────────────────────────────────────────

test("builder：listProviderRows 列出厂商与峰时段描述", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const rows = listProviderRows(path);
	assert.ok(rows.length >= 2);
	const ds = rows.find((r) => r.providerId === "deepseek");
	assert.equal(ds.modelCount, 2);
	assert.ok(ds.peakDesc.includes("峰"));
	assert.ok(ds.description.includes("9:00-12:00"));
	const glm = rows.find((r) => r.providerId === "glm");
	assert.equal(glm.peakDesc, "无峰时段");
	assert.ok(glm.description.includes("全天统一价"));
	rmSync(dir, { recursive: true, force: true });
});

test("builder：listModelRows 列出模型与价格行", () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const rows = listModelRows("deepseek", path);
	assert.equal(rows.length, 2);
	const flash = rows.find((r) => r.modelId === "deepseek-flash");
	assert.equal(flash.alias, "deepseek-v4-flash");
	assert.ok(flash.outputText.includes("¥4.00→¥8.00")); // 有峰 → 标准→峰
	assert.ok(flash.inputText.includes("¥1.00"));
	const pro = rows.find((r) => r.modelId === "deepseek-v4-pro");
	assert.ok(pro.outputText.includes("¥13.50→¥27.00"));
	// 未知厂商空数组
	assert.equal(listModelRows("nope", path).length, 0);
	rmSync(dir, { recursive: true, force: true });
});

// ── 抽屉（PricingDrawer）───────────────────────────────────────────────

function drawerCtx() {
	const ctx = {};
	const captured = {};
	ctx.captured = captured;
	ctx.ui = {
		custom: async (factory) => {
			captured.factory = factory;
		},
	};
	return ctx;
}

/** 运行抽屉工厂拿到可驱动的组件句柄（ANSI 序列用 \x1b 前缀编码） */
function runDrawer(captured) {
	assert.ok(captured.factory, "应调用 ctx.ui.custom 开抽屉");
	const theme = { fg: (color, text) => text, bold: (text) => text };
	let doneCount = 0;
	const handle = captured.factory({}, theme, {}, () => { doneCount += 1; });
	handle.doneCount = () => doneCount;
	return handle;
}

/** 提取渲染纯文本（去 ANSI 转义） */
function plainOf(handle, width = 90) {
	return handle.render(width).join("\n").replace(/\u001b\[\d+(;\d+)*m/g, "");
}

test("抽屉：headless（无 custom UI）返回 false", async () => {
	const ctx = { ui: {} };
	const drawer = new PricingDrawer();
	const opened = await drawer.open(ctx);
	assert.equal(opened, false);
});

test("抽屉：_open 捕获工厂并渲染厂商列表", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const ctx = drawerCtx();
	const drawer = new PricingDrawer(path);
	const opened = await drawer.open(ctx);
	assert.equal(opened, true);
	const handle = runDrawer(ctx.captured);
	const out = plainOf(handle);
	assert.ok(out.includes("模型计费配置 · 厂商"));
	assert.ok(out.includes("deepseek"));
	assert.ok(out.includes("glm"));
	assert.ok(out.includes("无峰时段"));
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：Enter 下钻 → Esc 返回，三级钻取闭环", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const ctx = drawerCtx();
	const drawer = new PricingDrawer(path);
	await drawer.open(ctx);
	const handle = runDrawer(ctx.captured);

	// 第 0 级厂商列表：Enter 进入 deepseek 模型列表
	handle.handleInput("\r");
	const level1 = plainOf(handle);
	assert.ok(level1.includes("deepseek-flash"), "应显示模型列表");
	assert.ok(level1.includes("模型计费配置 · deepseek"), "标题应更新为厂商层级");
	assert.ok(level1.includes("¥4.00→¥8.00"));

	// Esc 返回厂商列表，标题复原
	handle.handleInput("\x1b");
	const back0 = plainOf(handle);
	assert.ok(back0.includes("模型计费配置 · 厂商"), "标题应还原第 0 级");

	// 重新进入，下移到 deepseek-v4-pro，Enter 进入详情页
	handle.handleInput("\r");
	handle.handleInput("\x1b[B"); // 第 2 行 → deepseek-v4-pro
	handle.handleInput("\r");
	const detail = plainOf(handle);
	assert.ok(detail.includes("deepseek-v4-pro"));
	assert.ok(detail.includes("编辑"), "详情页应包含编辑提示");
	// 详情页无别名 → 不含"别名"字段
	assert.ok(!detail.includes("别名"));

	// Esc 返回模型列表
	handle.handleInput("\x1b");
	const back1 = plainOf(handle);
	assert.ok(back1.includes("deepseek-flash"), "应回到模型列表");
	assert.ok(back1.includes("模型计费配置 · deepseek"));

	// Esc 返回厂商列表并关闭（此时触发整体 done）
	handle.handleInput("\x1b");
	// 厂商列表 Esc → close 按钮触发 done
	const backClose = plainOf(handle);
	assert.ok(backClose.includes("模型计费配置 · 厂商"));
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：详情页引用 renderModelDetail 文本", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	// 直接对比抽屉详情的产物 = /price show 文本主体
	const ctx = drawerCtx();
	const drawer = new PricingDrawer(path);
	await drawer.open(ctx);
	const handle = runDrawer(ctx.captured);
	handle.handleInput("\r"); // 进入 deepseek
	handle.handleInput("\r"); // 首模型 deepseek-flash（有别名）
	const detail = plainOf(handle);
	assert.ok(detail.includes("deepseek/deepseek-flash"));
	assert.ok(detail.includes("别名: deepseek-v4-flash"));
	assert.ok(detail.includes("峰 ¥8.00/M"));
	assert.ok(detail.includes("峰 一/二/三/四/五 9-12 / 14-18"));
	rmSync(dir, { recursive: true, force: true });
});

// ── /price 命令接线 ─────────────────────────────────────────────────────

/** mock 的 ExtensionContext：只够 /price handler 跑的最小形状 */
function cmdCtx({ withCustom = true } = {}) {
	const notifications = [];
	const captured = {};
	return {
		ui: {
			notify: (text) => notifications.push(text),
			custom: async (factory) => {
				captured.factory = factory;
			},
			theme: { fg: (color, text) => text, bold: (text) => text },
		},
		notifications,
		captured,
		withCustom,
	};
}

/** mock 的 ExtensionAPI：记录注册的命令与事件 */
function cmdPi() {
	const commands = new Map();
	return {
		registerCommand: (name, options) => commands.set(name, options),
		commands,
	};
}

test("挂载：/price 无参在 TUI 下打开抽屉", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	seedPricing(path);
	const pi = cmdPi();
	const ctx = cmdCtx({ withCustom: true });
	const mounted = new PricingCommands(path);
	mounted.mount(pi);
	const handler = pi.commands.get("price").handler;
	await handler("", ctx);
	assert.ok(ctx.captured.factory, "无参应调用 ctx.ui.custom 开抽屉");
	assert.equal(ctx.notifications.length, 0, "抽屉模式下不应 notify 文本");
	rmSync(dir, { recursive: true, force: true });
});

test("挂载：/price 无参在 headless 下回退文本 list", async () => {
	const dir = tmpDir();
	const path = join(dir, "pricing.json");
	const ctx = cmdCtx({ withCustom: false });
	// headless：ui.custom 不存在
	ctx.ui = { notify: ctx.ui.notify };
	const pi = cmdPi();
	const mounted = new PricingCommands(path);
	mounted.mount(pi);
	const handler = pi.commands.get("price").handler;
	await handler("", ctx);
	assert.equal(ctx.captured.factory, undefined, "headless 不应开抽屉");
	assert.ok(ctx.notifications.some((t) => t.includes("deepseek")), "headless 应通知文本表格");
	rmSync(dir, { recursive: true, force: true });
});
