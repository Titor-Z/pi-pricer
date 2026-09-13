/**
 * pi-pricer /price 命令测试：6 子命令 headless 行为、写入落盘、引用保护、补全、AI 开关。
 *
 * 用 mock ExtensionAPI / ExtensionCommandContext 隔离 pi 运行时；
 * filePath 注入临时目录，避免污染真实 ~/.pi/。
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

const { PricingCommands, renderHelp, renderModelList } = await jiti.import(`${SRC}/pricing-commands.ts`);
const { readPricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { PRICE_SUBCOMMANDS } = await jiti.import(`${SRC}/pricing-cli-spec.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-cmd-"));
}

/** mock ExtensionAPI：记录注册的命令，模拟 active tools 集合 */
function mockPi() {
	const commands = new Map();
	const active = new Set(["read", "write"]);
	/** 记录每次 setActiveTools 的原始入参（保留重复，供断言） */
	const setCalls = [];
	return {
		commands,
		active,
		setCalls,
		registerCommand: (name, options) => commands.set(name, options),
		registerTool: () => {},
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			setCalls.push([...names]);
			active.clear();
			for (const n of names) active.add(n);
		},
	};
}

/** mock 命令上下文：记录 notify 文案 */
function mockCtx({ hasUI = true, confirm = true } = {}) {
	const notes = [];
	return {
		notes,
		hasUI,
		ui: {
			notify: (message, type) => notes.push({ message, type }),
			confirm: async () => confirm,
		},
	};
}

/** 运行一次命令，返回最后一条通知 */
async function run(pi, ctx, args) {
	await pi.commands.get("price").handler(args, ctx);
	return ctx.notes[ctx.notes.length - 1];
}

test("命令：/price ai 重复启用不产生重复工具名（Tool names must be unique）", async () => {
	const pi = mockPi();
	new PricingCommands().mount(pi);
	pi.active.add("price_get"); // 模拟 active 已经包含该工具
	const ctx = mockCtx({ confirm: true });
	await run(pi, ctx, "ai on");
	const last = pi.setCalls[pi.setCalls.length - 1];
	assert.equal(new Set(last).size, last.length, "传给 setActiveTools 的名字不应重复");
	assert.ok(last.includes("price_get") && last.includes("price_apply"), "应包含全部 AI 工具");
});

test("命令：挂载后 6 个命令面齐备，help 不含已删命令", () => {
	const pi = mockPi();
	new PricingCommands().mount(pi);
	assert.ok(pi.commands.has("price"), "应注册 price 命令");
	assert.deepEqual(
		PRICE_SUBCOMMANDS.map((s) => s.name),
		["rate", "calendar", "rule", "plan", "ai"],
		"子命令应为 5 个（+ 无参根命令 = 6 个命令面）",
	);
	const help = renderHelp();
	for (const name of ["rate", "calendar", "rule", "plan", "ai"]) assert.ok(help.includes(`/price ${name}`));
	for (const gone of ["/price model", "/price scheme", "/price resolve", "/price list", "/price bind"]) {
		assert.ok(!help.includes(gone), `help 不应含旧命令 ${gone}`);
	}
});

test("命令：无参列出已设定方案的模型（字母序 + 厂商标注）", async () => {
	const dir = tmpDir();
	const pi = mockPi();
	new PricingCommands(join(dir, "m.json")).mount(pi);
	const ctx = mockCtx();
	const note = await run(pi, ctx, "");
	assert.ok(note.message.includes("deepseek/deepseek-v4-flash"), "应列出模型");
	assert.ok(note.message.includes("Flash 默认"), "应显示方案别名");
	const order = ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "zai/glm-5.3-flash"];
	const positions = order.map((label) => note.message.indexOf(label));
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "应按字母序");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：rate add / set / remove，写入落盘，未引用可删", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	new PricingCommands(path).mount(pi);
	const ctx = mockCtx();

	await run(pi, ctx, 'rate add "促销价" 0.5 0.01 2');
	assert.ok(readPricing(path).rates.some((r) => r.name === "促销价"), "应落盘");

	await run(pi, ctx, 'rate set "促销价" output 3');
	assert.equal(readPricing(path).rates.find((r) => r.name === "促销价").output, 3);

	const listNote = await run(pi, ctx, "rate list");
	assert.ok(listNote.message.includes("促销价"), "列表应含新价格");

	await run(pi, ctx, 'rate remove "促销价"');
	assert.ok(!readPricing(path).rates.some((r) => r.name === "促销价"), "应删除");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：rate remove 被规则引用时拒绝（引用保护）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	new PricingCommands(path).mount(pi);
	const ctx = mockCtx();
	const note = await run(pi, ctx, 'rate remove "DeepSeek-v4-flash 谷价"');
	assert.equal(note.type, "error", "应报错");
	assert.ok(note.message.includes("仍被规则"), "应说明引用者");
	assert.ok(readPricing(path).rates.some((r) => r.name === "DeepSeek-v4-flash 谷价"), "不应删除");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：calendar add + add-dates + rule add（含星期/时段/日历引用）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	new PricingCommands(path).mount(pi);
	const ctx = mockCtx();

	await run(pi, ctx, 'calendar add "促销日" "2026-10-01,2026-10-02"');
	const cal = readPricing(path).calendars.find((c) => c.name === "促销日");
	assert.deepEqual(cal.dates, ["2026-10-01", "2026-10-02"]);

	await run(pi, ctx, 'calendar add-dates "促销日" "2026-10-03"');
	assert.deepEqual(readPricing(path).calendars.find((c) => c.name === "促销日").dates, ["2026-10-01", "2026-10-02", "2026-10-03"]);

	await run(
		pi,
		ctx,
		'rule add "国庆促销" "DeepSeek-v4-flash 谷价" --weekdays 1-5 --ranges 09:00-12:00,14:00-18:00 --include-cal "促销日"',
	);
	const rule = readPricing(path).rules.find((r) => r.name === "国庆促销");
	assert.deepEqual(rule.weekdays, [1, 2, 3, 4, 5]);
	assert.deepEqual(rule.ranges, [["09:00", "12:00"], ["14:00", "18:00"]]);
	assert.equal(rule.includeCalendars.length, 1, "应解析出日历引用");

	// 日历被规则引用 → 拒删
	const deny = await run(pi, ctx, 'calendar remove "促销日"');
	assert.equal(deny.type, "error");
	assert.ok(deny.message.includes("仍被规则"), "应说明引用者");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：plan add / add-rule / bind / disable / list（含反向引用）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	new PricingCommands(path).mount(pi);
	const ctx = mockCtx();

	await run(pi, ctx, 'plan add "新策略" "新策略HUD"');
	const plan = readPricing(path).plans.find((p) => p.name === "新策略");
	assert.equal(plan.alias, "新策略HUD");
	assert.equal("enabled" in plan, false, "方案不应再有启停字段");

	await run(pi, ctx, 'plan add-rule "新策略" "DeepSeek-v4-flash 全时谷价"');
	assert.equal(readPricing(path).plans.find((p) => p.name === "新策略").ruleIds.length, 1);

	await run(pi, ctx, 'plan bind testprov testmodel "新策略"');
	const model = readPricing(path).models.find((m) => m.provider === "testprov");
	assert.ok(model, "应创建模型绑定");
	assert.equal(model.enabled, true, "新绑定默认启用");

	await run(pi, ctx, 'plan disable-model testprov testmodel');
	assert.equal(readPricing(path).models.find((m) => m.provider === "testprov").enabled, false);

	const listNote = await run(pi, ctx, "plan list");
	assert.ok(listNote.message.includes("testprov/testmodel"), "列表应显示反向引用");
	assert.ok(renderModelList(readPricing(path)).includes("[已禁用]"), "模型列表应标注禁用");

	// 被绑定 → 拒删
	const deny = await run(pi, ctx, 'plan remove "新策略"');
	assert.equal(deny.type, "error");
	assert.ok(deny.message.includes("仍被模型"), "应说明引用者");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：plan remove-rule 可清空规则、remove 未绑定可删", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	new PricingCommands(path).mount(pi);
	const ctx = mockCtx();

	// 种子方案 deepseek-v4-flash 有 2 条规则：可逐条移出（允许空方案）
	await run(pi, ctx, 'plan remove-rule "deepseek-v4-flash 方案" "DeepSeek-v4-flash 全时谷价"');
	assert.equal(readPricing(path).plans.find((p) => p.name === "deepseek-v4-flash 方案").ruleIds.length, 1);
	await run(pi, ctx, 'plan remove-rule "deepseek-v4-flash 方案" "DeepSeek-v4-flash 工作日高峰"');
	assert.equal(readPricing(path).plans.find((p) => p.name === "deepseek-v4-flash 方案").ruleIds.length, 0, "允许清空规则");

	// 新建未被引用的方案可删（含空方案）
	await run(pi, ctx, 'plan add "临时方案"');
	await run(pi, ctx, 'plan remove "临时方案"');
	assert.ok(!readPricing(path).plans.some((p) => p.name === "临时方案"));
	rmSync(dir, { recursive: true, force: true });
});

test("命令：未知子命令 / 未知动作给出提示不抛错", async () => {
	const dir = tmpDir();
	const pi = mockPi();
	new PricingCommands(join(dir, "m.json")).mount(pi);
	const ctx = mockCtx();
	const unknown = await run(pi, ctx, "bogus");
	assert.equal(unknown.type, "warning");
	assert.ok(unknown.message.includes("未知子命令"));
	rmSync(dir, { recursive: true, force: true });
});

test("命令：补全按层级给候选（子命令 / 动作 / 动态 name）", () => {
	const dir = tmpDir();
	const cmd = new PricingCommands(join(dir, "m.json"));
	assert.ok(cmd.completions("r").some((c) => c.value === "rate"), "一级：r → rate");
	assert.ok(cmd.completions("rate ").some((c) => c.value === "add"), "二级：rate → add");
	assert.ok(cmd.completions("rate set ").some((c) => c.label === "DeepSeek-v4-flash 谷价"), "三级：价格名");
	assert.ok(cmd.completions("rate set \"DeepSeek").some((c) => c.value.includes("DeepSeek-v4-flash 谷价")), "含空格 name 应加引号");
	assert.equal(cmd.completions("bogus ").length, 0, "未知子命令无候选");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：/price ai on|off 切换激活工具集；headless 拒绝", async () => {
	const dir = tmpDir();
	const pi = mockPi();
	new PricingCommands(join(dir, "m.json")).mount(pi);
	const ctx = mockCtx({ hasUI: true });

	await run(pi, ctx, "ai on");
	assert.ok(pi.active.has("price_get") && pi.active.has("price_save"), "应激活 AI 工具");
	assert.ok(pi.active.has("read"), "不应丢失原有工具");

	await run(pi, ctx, "ai off");
	assert.ok(!pi.active.has("price_get"), "应停用 AI 工具");
	assert.ok(pi.active.has("read"));

	const headless = mockCtx({ hasUI: false });
	await run(pi, headless, "ai on");
	assert.equal(headless.notes[headless.notes.length - 1].type, "warning", "headless 应提示不支持");
	rmSync(dir, { recursive: true, force: true });
});

test("命令：renderModelList 对启用/禁用模型的标注", () => {
	const dir = tmpDir();
	const schema = readPricing(join(dir, "m.json"));
	assert.ok(renderModelList(schema).includes("[启用]"), "默认种子应标注启用");
	const disabled = { ...schema, models: schema.models.map((m) => ({ ...m, enabled: false })) };
	assert.ok(renderModelList(disabled).includes("[已禁用]"), "禁用模型应标注已禁用");
	rmSync(dir, { recursive: true, force: true });
});
