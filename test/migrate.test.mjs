/**
 * 价表迁移测试：修正历史种子的 GLM provider（glm → zai）、补齐 DeepSeek Flash
 * 双别名、改名旧种子方案；要求幂等、不误伤无关数据、且**已迁移文件不复活被删别名**。
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

const { migrateSchema } = await jiti.import(`${SRC}/pricing-migrate.ts`);
const { readPricing, writePricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { DEFAULT_PRICING } = await jiti.import(`${SRC}/pricing-defaults.ts`);

/** 还原成历史种子的样子：provider glm + 旧方案名 + 只有 deepseek-flash（无 v4 名） */
function legacyFixture() {
	const s = structuredClone(DEFAULT_PRICING);
	s.models = s.models.filter((m) => m.model !== "deepseek-v4-flash");
	s.models.find((m) => m.model === "glm-5.3-flash").provider = "glm";
	s.plans[0].name = "deepseek-flash 方案";
	return s;
}

test("migrate：补齐 DeepSeek Flash 双别名（deepseek-v4-flash + deepseek-flash）", () => {
	const out = migrateSchema(legacyFixture());
	const a = out.models.find((m) => m.model === "deepseek-v4-flash");
	const b = out.models.find((m) => m.model === "deepseek-flash");
	assert.ok(a, "应补齐 pi 注册表旧名");
	assert.ok(b, "应保留官方名");
	assert.equal(a.planId, b.planId, "两别名应绑同一方案");
});

test("migrate：修正 provider glm → zai", () => {
	const out = migrateSchema(legacyFixture());
	assert.ok(out.models.some((m) => m.provider === "zai" && m.model === "glm-5.3-flash"), "应修正为 zai");
	assert.ok(!out.models.some((m) => m.provider === "glm"), "不应残留 glm provider");
});

test("migrate：种子方案名 deepseek-flash 方案 → deepseek-v4-flash 方案", () => {
	const out = migrateSchema(legacyFixture());
	assert.ok(out.plans.some((p) => p.name === "deepseek-v4-flash 方案"), "应变更为新方案名");
	assert.ok(!out.plans.some((p) => p.name === "deepseek-flash 方案"), "不应残留旧方案名");
});

test("migrate：幂等 —— 跑两次结果一致", () => {
	const once = migrateSchema(legacyFixture());
	const twice = migrateSchema(once);
	assert.deepEqual(twice, once, "第二次不应再产生变化");
});

test("migrate：干净种子无变更时原样返回（不产生新对象）", () => {
	const clean = structuredClone(DEFAULT_PRICING);
	assert.equal(migrateSchema(clean), clean, "无需迁移时应返回同一引用");
});

test("migrate：已迁移文件删掉某别名后不会被复活", () => {
	const migrated = structuredClone(DEFAULT_PRICING);
	migrated.models = migrated.models.filter((m) => m.model !== "deepseek-v4-flash"); // 用户手动删除
	const out = migrateSchema(migrated);
	assert.ok(!out.models.some((m) => m.model === "deepseek-v4-flash"), "非历史种子不应补回已删别名");
	assert.ok(out.models.some((m) => m.model === "deepseek-flash"), "保留的别名不应被动");
});

test("migrate：不误伤无关的自定义数据", () => {
	const schema = structuredClone(DEFAULT_PRICING);
	schema.models.push({ _id: "eeeeeeeeeeeeeeee", createdAt: new Date().toISOString(), provider: "deepseek", model: "my-custom-model", planId: schema.plans[1]._id });
	schema.plans[1].name = "我的自定义方案";
	schema.plans[1].alias = "自定义";
	const out = migrateSchema(schema);
	assert.ok(out.models.some((m) => m.model === "my-custom-model"), "自定义模型应保留");
	assert.equal(out.plans.find((p) => p.alias === "自定义")?.name, "我的自定义方案", "自定义方案名不应被改");
});

test("migrate：移除方案级 enabled，并将历史模型 enabled 残留清为启用", () => {
	const legacy = legacyFixture();
	legacy.plans[0].enabled = false;
	legacy.models.find((m) => m.model === "deepseek-flash").enabled = false;
	const out = migrateSchema(legacy);
	assert.equal("enabled" in out.plans[0], false, "方案不应再有 enabled 字段");
	assert.equal(out.models.find((m) => m.model === "deepseek-flash").enabled, true, "历史残留启停应清为启用");
});

test("migrate：已迁移文件的模型禁用态不被重置", () => {
	const migrated = structuredClone(DEFAULT_PRICING);
	migrated.models.find((m) => m.model === "deepseek-flash").enabled = false;
	const out = migrateSchema(migrated);
	assert.equal(out.models.find((m) => m.model === "deepseek-flash").enabled, false, "用户禁用的模型应保持禁用");
});

test("readPricing：读到 v5 历史数据时自动应用迁移", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-pricer-migrate-"));
	const path = join(dir, "m.json");
	writePricing(legacyFixture(), path);
	try {
		const read = readPricing(path);
		assert.ok(read.models.some((m) => m.provider === "deepseek" && m.model === "deepseek-v4-flash"), "应补齐 v4 别名");
		assert.ok(read.models.some((m) => m.provider === "deepseek" && m.model === "deepseek-flash"), "应保留官方别名");
		assert.ok(read.models.some((m) => m.provider === "zai" && m.model === "glm-5.3-flash"), "应修正 provider");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
