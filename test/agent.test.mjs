/**
 * pi-pricer AI 层测试：语义动作分发一致性、整批原子、草稿 → 预览 → 落盘 → 丢弃、工具启用守卫。
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

const { PricingAgentService, applyAction, diffSchemas, describeSchema } = await jiti.import(`${SRC}/pricing-agent.ts`);
const { PricingAgentTools } = await jiti.import(`${SRC}/pricing-agent-tool.ts`);
const { PRICING_ACTION_KINDS, PricingActionSchema } = await jiti.import(`${SRC}/pricing-agent-actions.ts`);
const { PricingCommands } = await jiti.import(`${SRC}/pricing-commands.ts`);
const { readPricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { Database } = await jiti.import(`${SRC}/db/database.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-ai-"));
}

/** mock ExtensionAPI：记录注册的工具、命令与激活集 */
function mockPi() {
	const tools = new Map();
	const commands = new Map();
	const active = new Set(["read"]);
	return {
		tools,
		commands,
		active,
		registerTool: (def) => tools.set(def.name, def),
		registerCommand: (name, options) => commands.set(name, options),
		getActiveTools: () => [...active],
		setActiveTools: (names) => {
			active.clear();
			for (const n of names) active.add(n);
		},
	};
}

test("动作一致性：PRICING_ACTION_KINDS 每个 kind 都有分发分支（无遗漏）", () => {
	// 为每个 kind 造一个最小动作；只要不是"未知动作"即说明分发存在
	const samples = {
		upsertRate: { kind: "upsertRate", name: "一致性价", inputMiss: 1, inputHit: 1, output: 1 },
		deleteRate: { kind: "deleteRate", name: "一致性价" },
		upsertCalendar: { kind: "upsertCalendar", name: "一致性日历", dates: [] },
		addCalendarDates: { kind: "addCalendarDates", name: "一致性日历", dates: ["01-01"] },
		deleteCalendar: { kind: "deleteCalendar", name: "一致性日历" },
		upsertRule: { kind: "upsertRule", name: "一致性规则", rateName: "一致性价" },
		deleteRule: { kind: "deleteRule", name: "一致性规则" },
		upsertPlan: { kind: "upsertPlan", name: "一致性方案", ruleNames: [] },
		setModelEnabled: { kind: "setModelEnabled", provider: "p", model: "m", enabled: false },
		deletePlan: { kind: "deletePlan", name: "一致性方案" },
		unbindModel: { kind: "unbindModel", provider: "p", model: "m" },
		bindModel: { kind: "bindModel", provider: "p", model: "m", planName: "一致性方案" },
	};
	assert.deepEqual(
		[...PRICING_ACTION_KINDS].sort(),
		Object.keys(samples).sort(),
		"一致性样本需覆盖全部 kind",
	);
	for (const kind of PRICING_ACTION_KINDS) {
		const dir = tmpDir();
		const db = Database.open(join(dir, "m.json"));
		const tx = db.begin();
		let unknown = false;
		try {
			applyAction(tx, samples[kind]);
		} catch (error) {
			unknown = String(error.message).includes("未知动作");
		}
		assert.equal(unknown, false, `kind ${kind} 不应落到未知动作分支`);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("动作：upsertRate 新建与覆盖、bindModel 与 unbindModel", () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const service = new PricingAgentService(path);

	let result = service.applyActions([
		{ kind: "upsertRate", name: "新价", inputMiss: 1, inputHit: 0.5, output: 2 },
	]);
	assert.equal(result.ok, true, "新建应成功");
	result = service.applyActions([{ kind: "upsertRate", name: "新价", inputMiss: 9, inputHit: 1, output: 9 }]);
	assert.equal(result.ok, true, "同名 upsert 应覆盖");
	// upsertPlan（空规则组）+ bindModel
	result = service.applyActions([
		{ kind: "upsertPlan", name: "新方案", alias: "NP", ruleNames: [] },
		{ kind: "bindModel", provider: "acme", model: "acme-1", planName: "新方案" },
	]);
	assert.equal(result.ok, true);
	service.discard();
	rmSync(dir, { recursive: true, force: true });
});

test("整批原子：任一动作失败 → 整批回滚，草稿清空，磁盘不变", () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const service = new PricingAgentService(path);
	const before = readPricing(path);

	const result = service.applyActions([
		{ kind: "upsertRate", name: "本该回滚的价格", inputMiss: 1, inputHit: 1, output: 1 },
		{ kind: "upsertRule", name: "坏规则", rateName: "不存在的价格" },
	]);
	assert.equal(result.ok, false, "应整批失败");
	assert.ok(result.failures.some((f) => f.kind === "upsertRule"), "应带失败动作 kind");
	assert.equal(service.hasPending, false, "失败后不应残留草稿");
	assert.deepEqual(readPricing(path).rates.length, before.rates.length, "磁盘不变");

	// 失败后重新 apply 应干净（前一批不残留）
	const ok = service.applyActions([{ kind: "upsertRate", name: "干净的新价", inputMiss: 1, inputHit: 1, output: 1 }]);
	assert.equal(ok.ok, true);
	assert.equal(service.diffPreview().includes("本该回滚的价格"), false, "不应残留失败批次");
	rmSync(dir, { recursive: true, force: true });
});

test("闭环：apply → diffPreview → commit 落盘 → discard 丢弃", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const service = new PricingAgentService(path);

	service.applyActions([
		{ kind: "upsertRate", name: "闭环价", inputMiss: 2, inputHit: 1, output: 3 },
		{ kind: "upsertCalendar", name: "闭环日历", dates: ["01-01"] },
		{ kind: "upsertRule", name: "闭环规则", rateName: "闭环价", includeCalendars: ["闭环日历"] },
		{ kind: "upsertPlan", name: "闭环方案", ruleNames: ["闭环规则"] },
		{ kind: "bindModel", provider: "acme", model: "acme-2", planName: "闭环方案" },
	]);

	const preview = service.diffPreview();
	assert.ok(preview.includes("＋ 价格：闭环价"), "预览应含新增价格");
	assert.ok(preview.includes("＋ 模型：acme/acme-2"), "预览应含新增模型");

	const saved = await service.commit();
	assert.equal(saved.ok, true, "应保存成功");
	assert.equal(service.hasPending, false, "保存后无草稿");
	const disk = readPricing(path);
	assert.ok(disk.rates.some((r) => r.name === "闭环价"), "应落盘价格");
	assert.ok(disk.models.some((m) => m.provider === "acme" && m.model === "acme-2"), "应落盘模型绑定");

	// discard 丢弃
	service.applyActions([{ kind: "upsertRate", name: "将被丢弃", inputMiss: 1, inputHit: 1, output: 1 }]);
	assert.equal(service.hasPending, true);
	service.discard();
	assert.equal(service.hasPending, false);
	assert.ok(!readPricing(path).rates.some((r) => r.name === "将被丢弃"), "丢弃不应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("diffSchemas / describeSchema 基础行为", () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const before = readPricing(path);
	const after = {
		...before,
		rates: [...before.rates, { _id: "abcdefabcdefabcd", createdAt: new Date().toISOString(), name: "X", inputMiss: 1, inputHit: 1, output: 1 }],
	};
	const diff = diffSchemas(before, after);
	assert.ok(diff.includes("＋ 价格：X"), "应识别新增");
	const summary = describeSchema(before);
	assert.ok(summary.includes("价格表"), "摘要应含价格表");
	assert.ok(summary.includes("模型绑定"), "摘要应含模型绑定");
	rmSync(dir, { recursive: true, force: true });
});

test("工具：未启用返回指引；setEnabled 后可正常执行；注册 5 个工具", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	const tools = new PricingAgentTools(new PricingAgentService(path));
	tools.register(pi);
	assert.deepEqual(
		[...pi.tools.keys()].sort(),
		["price_apply", "price_discard", "price_get", "price_review", "price_save"],
		"应注册 5 个工具",
	);

	const get = pi.tools.get("price_get");
	const disabled = await get.execute("id", {}, undefined, undefined, {});
	assert.ok(disabled.content[0].text.includes("/price ai"), "未启用应返回指引");

	tools.setEnabled(true);
	const enabled = await get.execute("id", {}, undefined, undefined, {});
	assert.ok(enabled.content[0].text.includes("价格表"), "启用后应返回现状摘要");

	// price_apply 失败返回整批回滚说明，且不抛错
	const apply = pi.tools.get("price_apply");
	const applied = await apply.execute("id", { actions: [{ kind: "upsertRule", name: "x", rateName: "不存在" }] }, undefined, undefined, {});
	assert.ok(applied.content[0].text.includes("整批回滚"), "失败应转为文本而非抛错");
	rmSync(dir, { recursive: true, force: true });
});

test("/price ai 联动：启用后 active 含 price_*，且工具服务被启用", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const pi = mockPi();
	const tools = new PricingAgentTools(new PricingAgentService(path));
	tools.register(pi);
	new PricingCommands(path, tools).mount(pi);

	const ctx = { hasUI: true, ui: { notify: () => {}, confirm: async () => true } };
	await pi.commands.get("price").handler("ai on", ctx);
	assert.ok(pi.active.has("price_get") && pi.active.has("price_save"), "应激活 AI 工具");
	assert.equal(tools.isEnabled, true, "工具服务应被启用");

	// 启用后调用 price_get 应返回摘要（而非未启用指引）
	const got = await pi.tools.get("price_get").execute("id", {}, undefined, undefined, {});
	assert.ok(got.content[0].text.includes("价格表"), "启用后工具可用");

	await pi.commands.get("price").handler("ai off", ctx);
	assert.ok(!pi.active.has("price_get"), "应停用 AI 工具");
	assert.equal(tools.isEnabled, false, "工具服务应被停用");
	rmSync(dir, { recursive: true, force: true });
});

test("PricingActionSchema 与 PRICING_ACTION_KINDS 数量一致", () => {
	const anyOf = PricingActionSchema.anyOf ?? [];
	assert.equal(anyOf.length, PRICING_ACTION_KINDS.length, "schema 联合成员数应等于 kind 数");
});
