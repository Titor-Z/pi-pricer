/**
 * 端到端：命令 → 抽屉（TUI）接线，以及二级动作仍走文本执行。
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

const { PricingCommands } = await jiti.import(`${SRC}/pricing-commands.ts`);
const { readPricing } = await jiti.import(`${SRC}/pricing-store.ts`);

const theme = { fg: (_c, t) => t, bold: (t) => t };

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-e2e-"));
}

/** mock pi + ctx（TUI），captured 记录 custom 工厂与 notify */
function makeTuiPi() {
	const commands = new Map();
	const captured = { factory: null, notes: [] };
	const pi = {
		commands,
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: () => {},
		getActiveTools: () => ["read"],
		setActiveTools: () => {},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async (f) => {
				captured.factory = f;
				return undefined;
			},
			notify: (message, type) => captured.notes.push({ message, type }),
		},
	};
	return { pi, ctx, captured };
}

test("端到端：/price 在 TUI 下开抽屉（根页）", async () => {
	const dir = tmpDir();
	const { pi, ctx, captured } = makeTuiPi();
	new PricingCommands(join(dir, "m.json")).mount(pi);
	await pi.commands.get("price").handler("", ctx);
	assert.ok(captured.factory, "应调用 ctx.ui.custom 开抽屉");
	const component = captured.factory({}, theme, {}, () => {});
	assert.ok(component.render(80).join("\n").includes("模型"), "根页面包屑应为模型");
	rmSync(dir, { recursive: true, force: true });
});

test("端到端：/price plan|rate|calendar|rule 在 TUI 下直达对应页", async () => {
	for (const [sub, marker] of [
		["rate", "价格"],
		["calendar", "日历"],
		["rule", "规则"],
		["plan", "方案"],
	]) {
		const dir = tmpDir();
		const { pi, ctx, captured } = makeTuiPi();
		new PricingCommands(join(dir, "m.json")).mount(pi);
		await pi.commands.get("price").handler(sub, ctx);
		assert.ok(captured.factory, `${sub} 应开抽屉`);
		const component = captured.factory({}, theme, {}, () => {});
		assert.ok(component.render(80).join("\n").includes(marker), `${sub} 应直达 ${marker}`);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("端到端：带二级动作时不开抽屉，改走文本执行", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { pi, ctx, captured } = makeTuiPi();
	new PricingCommands(path).mount(pi);
	await pi.commands.get("price").handler('rate add "端到端价" 1 2 3', ctx);
	assert.equal(captured.factory, null, "带动作不应开抽屉");
	assert.ok(captured.notes.some((n) => n.message.includes("已新建价格")), "应给出文本反馈");
	assert.ok(readPricing(path).rates.some((r) => r.name === "端到端价"), "动作应生效");
	rmSync(dir, { recursive: true, force: true });
});

test("端到端：headless（print）下 /price 回退文本列表", async () => {
	const dir = tmpDir();
	const notes = [];
	const pi = {
		registerCommand: (name, options) => pi._cmd = options,
		registerTool: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
	};
	new PricingCommands(join(dir, "m.json")).mount(pi);
	const ctx = { mode: "print", hasUI: false, ui: { notify: (message, type) => notes.push({ message, type }), custom: async () => undefined } };
	await pi._cmd.handler("", ctx);
	assert.ok(notes.some((n) => n.message.includes("deepseek/deepseek-flash")), "应回退文本模型列表");
	rmSync(dir, { recursive: true, force: true });
});
