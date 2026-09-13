/**
 * pi-pricer v5 数据层测试：id / Collection / validate / store / defaults / Database（事务）。
 *
 * 约定：使用临时目录隔离文件 IO；jiti 直载 src/*.ts（.mjs 禁写 TS 语法）；
 * 模块路径从 import.meta.url 派生，禁止硬编码本机路径。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const { generateId, isValidId, idTimestamp } = await jiti.import(`${SRC}/db/id.ts`);
const { Collection } = await jiti.import(`${SRC}/db/collection.ts`);
const {
	validateSchema,
	checkRateDeletable,
	checkCalendarDeletable,
	checkRuleDeletable,
	checkPlanDeletable,
} = await jiti.import(`${SRC}/db/validate.ts`);
const { readPricing, writePricing, seedPricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { DEFAULT_PRICING } = await jiti.import(`${SRC}/pricing-defaults.ts`);
const { Database } = await jiti.import(`${SRC}/db/database.ts`);

/** 临时目录 */
function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-"));
}

/** 合法规则骨架（便于测试构造变体） */
function ruleFields(overrides = {}) {
	return {
		name: "测试规则",
		rateId: "",
		timezone: "Asia/Shanghai",
		weekdays: [],
		ranges: [],
		includeCalendars: [],
		excludeCalendars: [],
		includeDates: [],
		excludeDates: [],
		...overrides,
	};
}

// ── id ───────────────────────────────────────────────────────────────────

test("id：16 位十六进制、唯一、时间戳可反解、非法拒绝", () => {
	const ids = Array.from({ length: 50 }, () => generateId());
	assert.ok(ids.every((id) => id.length === 16 && isValidId(id)), "应全为 16 位 hex");
	assert.equal(new Set(ids).size, ids.length, "应唯一");
	assert.ok(Math.abs(idTimestamp(ids[0]) - Date.now()) < 5000, "时间戳应接近当前");
	assert.equal(idTimestamp("not-an-id"), 0, "非法 id 反解返回 0");
	assert.ok(!isValidId("507f1f77bcf86cd799439011"), "24 位不应通过 16 位校验");
});

// ── Collection ───────────────────────────────────────────────────────────

test("Collection：CRUD、删除后索引、updateOne 忽略 createdAt、唯一性、深拷贝", () => {
	const c = new Collection("rates");
	const a = c.insertOne({ name: "谷价", output: 4 });
	const b = c.insertOne({ name: "峰价", output: 8 });
	assert.equal(c.count(), 2);
	assert.equal(c.findById(a._id).name, "谷价");
	assert.equal(c.findOne((d) => d.name === "峰价")._id, b._id);
	assert.equal(c.find((d) => d.output > 4).length, 1);

	const created = c.findById(a._id).createdAt;
	c.updateOne(a._id, { output: 5, createdAt: "HACKED" });
	assert.equal(c.findById(a._id).output, 5);
	assert.equal(c.findById(a._id).createdAt, created, "createdAt 不可篡改");
	assert.ok(c.findById(a._id).updatedAt, "updatedAt 应写入");

	assert.equal(c.deleteOne(b._id), true);
	assert.equal(c.count(), 1);
	assert.equal(c.findById(a._id).name, "谷价", "删除后索引仍有效");
	assert.equal(c.deleteOne("ffffffffffffffff"), false, "删不存在返回 false");

	const id = a._id;
	assert.throws(() => c.ensureUniqueName("谷价"), /同名文档/, "重名应抛错");
	c.ensureUniqueName("谷价", id); // 排除自身 → 不抛

	const copy = c.toArray();
	copy[0].output = 999;
	assert.equal(c.findById(id).output, 5, "toArray 应为深拷贝");
});

// ── validate ─────────────────────────────────────────────────────────────

test("validate：种子自洽通过；重复 name / 悬空引用 / 非法格式被拒", () => {
	assert.deepEqual(validateSchema(DEFAULT_PRICING), [], "内置种子应无问题");

	const rate = DEFAULT_PRICING.rates[0];
	const rule = DEFAULT_PRICING.rules[0];
	const plan = DEFAULT_PRICING.plans[0];

	// 重复 name
	const dupRates = { ...DEFAULT_PRICING, rates: [...DEFAULT_PRICING.rates, { ...rate, _id: generateId() }] };
	assert.ok(validateSchema(dupRates).some((s) => s.includes("重复 name")), "重复 name 应报错");

	// 悬空 rateId
	const danglingRate = {
		...DEFAULT_PRICING,
		rules: [{ ...rule, rateId: "ffffffffffffffff" }],
	};
	assert.ok(validateSchema(danglingRate).some((s) => s.includes("不存在的价格")), "悬空 rateId 应报错");

	// 非法星期 / 时段 / 日期
	const badWeekday = { ...DEFAULT_PRICING, rules: [{ ...rule, weekdays: [9] }] };
	assert.ok(validateSchema(badWeekday).some((s) => s.includes("星期取值非法")));
	const badRange = { ...DEFAULT_PRICING, rules: [{ ...rule, ranges: [["18:00", "09:00"]] }] };
	assert.ok(validateSchema(badRange).some((s) => s.includes("起点不小于终点")));
	const badDate = { ...DEFAULT_PRICING, rules: [{ ...rule, includeDates: ["2026-13-99"] }] };
	assert.ok(validateSchema(badDate).some((s) => s.includes("日期非法")));

	// 空方案合法（先建方案再逐步纳入规则）；悬空 ruleId 仍拒绝
	const emptyPlan = { ...plan, _id: generateId(), name: "空方案", ruleIds: [] };
	assert.deepEqual(validateSchema({ ...DEFAULT_PRICING, plans: [...DEFAULT_PRICING.plans, emptyPlan] }), [], "空方案应允许");
	assert.ok(validateSchema({ ...DEFAULT_PRICING, plans: [{ ...plan, ruleIds: ["ffffffffffffffff"] }] }).some((s) => s.includes("不存在的规则")));

	// 模型悬空 planId
	assert.ok(validateSchema({ ...DEFAULT_PRICING, models: [{ ...DEFAULT_PRICING.models[0], planId: "ffffffffffffffff" }] }).some((s) => s.includes("不存在的方案")));

	// 模型组合重复
	const dupModel = { ...DEFAULT_PRICING, models: [...DEFAULT_PRICING.models, { ...DEFAULT_PRICING.models[0], _id: generateId() }] };
	assert.ok(validateSchema(dupModel).some((s) => s.includes("模型组合重复")));
});

test("validate：四类删除保护（被引用拒绝，未引用允许）", () => {
	const rule = DEFAULT_PRICING.rules[0];
	const plan = DEFAULT_PRICING.plans[0];
	assert.ok(!checkRateDeletable(DEFAULT_PRICING, rule.rateId).ok, "被规则引用的价格应拒删");
	assert.ok(!checkRuleDeletable(DEFAULT_PRICING, plan.ruleIds[0]).ok, "被方案引用的规则应拒删");
	assert.ok(!checkPlanDeletable(DEFAULT_PRICING, plan._id).ok, "被模型绑定的方案应拒删");

	const unusedRate = { ...DEFAULT_PRICING, rates: [...DEFAULT_PRICING.rates, { _id: generateId(), name: "没人用的价", inputMiss: 1, inputHit: 1, output: 1, createdAt: new Date().toISOString() }] };
	const last = unusedRate.rates[unusedRate.rates.length - 1];
	assert.ok(checkRateDeletable(unusedRate, last._id).ok, "未被引用的价格应允许删除");

	// 日历引用保护
	const cal = { _id: generateId(), name: "节假日", dates: ["01-01"], createdAt: new Date().toISOString() };
	const withCal = {
		...DEFAULT_PRICING,
		calendars: [cal],
		rules: [{ ...rule, excludeCalendars: [cal._id] }],
	};
	assert.ok(!checkCalendarDeletable(withCal, cal._id).ok, "被规则引用的日历应拒删");
});

// ── store ────────────────────────────────────────────────────────────────

test("store：缺失/损坏/旧版本 → v5 种子；旧文件不被静默覆盖", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");

	assert.equal(readPricing(p).version, 5, "缺失 → v5 种子");

	writeFileSync(p, "{bad json", "utf8");
	assert.equal(readPricing(p).version, 5, "损坏 → v5 种子");

	writeFileSync(p, JSON.stringify({ version: 2, providers: {} }), "utf8");
	assert.equal(readPricing(p).version, 5, "旧版本 → v5 种子");
	assert.equal(JSON.parse(readFileSync(p, "utf8")).version, 2, "旧文件应保持原样");
	rmSync(dir, { recursive: true, force: true });
});

test("store：写入为原子操作、无临时残留、seedPricing 不覆盖已存在", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const schema = readPricing(p);
	schema.rates[0].output = 99;
	writePricing(schema, p);
	assert.equal(readPricing(p).rates[0].output, 99, "写读回环一致");
	assert.equal(JSON.parse(readFileSync(p, "utf8")).version, 5);
	assert.ok(!existsSync(`${p}.tmp`), "不应残留临时文件");

	seedPricing(p);
	assert.equal(readPricing(p).rates[0].output, 99, "已存在文件不应被种子覆盖");

	const p2 = join(dir, "new.json");
	seedPricing(p2);
	assert.ok(existsSync(p2) && readPricing(p2).version === 5, "新文件应被播种");
	rmSync(dir, { recursive: true, force: true });
});

// ── Database（事务） ──────────────────────────────────────────────────────

test("Database：事务提交落盘、内存态一致、explainPlan 跨表 join", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const plan = db.plans.findOne((x) => x.name === "deepseek-v4-flash 方案");

	const newRuleId = db.transaction((tx) => {
		const rate = tx.rates.insertOne({ name: "促销价", inputMiss: 0.5, inputHit: 0.01, output: 2 });
		const rule = tx.rules.insertOne(ruleFields({ name: "促销规则", rateId: rate._id }));
		const current = tx.plans.findById(plan._id);
		tx.plans.updateOne(plan._id, { ruleIds: [...current.ruleIds, rule._id] });
		return rule._id;
	});

	assert.ok(readPricing(p).rules.some((r) => r._id === newRuleId), "提交应落盘");
	assert.equal(db.rules.findById(newRuleId).name, "促销规则", "内存态应并入");
	const ex = db.explainPlan(plan._id);
	assert.equal(ex.rules.length, 3, "explainPlan 应展开三条规则");
	assert.ok(ex.rules.every((r) => r.rate), "每条规则都应解析出价格");
	rmSync(dir, { recursive: true, force: true });
});

test("Database：悬空引用整笔回滚（磁盘无残留）", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const before = db.snapshot();

	assert.throws(
		() => db.transaction((tx) => {
			tx.rules.insertOne(ruleFields({ name: "坏规则", rateId: "ffffffffffffffff" }));
		}),
		(err) => err.name === "ValidationError",
		"悬空引用应抛 ValidationError",
	);
	assert.ok(!readPricing(p).rules.some((r) => r.name === "坏规则"), "磁盘不应有坏规则");
	assert.equal(db.rules.count(), before.rules.length, "内存态应回滚");
	rmSync(dir, { recursive: true, force: true });
});

test("Database：fn 抛错回滚，磁盘与内存均不变", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const ratesBefore = readPricing(p).rates.length;

	assert.throws(
		() => db.transaction((tx) => {
			tx.rates.deleteOne(db.rates.all()[0]._id);
			throw new Error("boom");
		}),
		/boom/,
	);
	assert.equal(readPricing(p).rates.length, ratesBefore, "磁盘不变");
	assert.equal(db.rates.count(), ratesBefore, "内存不变");
	rmSync(dir, { recursive: true, force: true });
});

test("Database：乐观锁阻止覆盖外部改动", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db1 = Database.open(p);
	const db2 = Database.open(p);

	db1.transaction((tx) => {
		tx.rates.updateOne(db1.rates.all()[0]._id, { output: 123 });
	});

	assert.throws(
		() => db2.transaction((tx) => {
			tx.rates.updateOne(db2.rates.all()[0]._id, { output: 999 });
		}),
		(err) => err.name === "ConcurrencyError",
		"外部已修改应拒提交",
	);
	assert.equal(readPricing(p).rates[0].output, 123, "不应被覆盖");
	rmSync(dir, { recursive: true, force: true });
});

test("Database：reload 刷新内存态与乐观锁基线", () => {
	const dir = tmpDir();
	const p = join(dir, "m.json");
	const db = Database.open(p);
	const other = Database.open(p);
	other.transaction((tx) => {
		tx.rates.updateOne(other.rates.all()[0]._id, { output: 77 });
	});
	db.reload();
	assert.equal(db.rates.all()[0].output, 77, "reload 应读到最新值");
	// reload 后基线已刷新 → 可正常提交
	db.transaction((tx) => {
		tx.rates.updateOne(db.rates.all()[0]._id, { output: 88 });
	});
	assert.equal(readPricing(p).rates[0].output, 88);
	rmSync(dir, { recursive: true, force: true });
});
