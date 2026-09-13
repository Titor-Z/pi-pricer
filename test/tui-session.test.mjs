/**
 * TUI 草稿会话测试：脏标记、落盘、重置、校验失败不落盘。
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

const { PricingSession } = await jiti.import(`${SRC}/tui/pricing-session.ts`);
const { readPricing } = await jiti.import(`${SRC}/pricing-store.ts`);

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-tui-"));
}

test("PricingSession：初始不脏、编辑变脏、save 落盘后回净", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const session = new PricingSession(path);
	assert.equal(session.isDirty, false, "初始应干净");

	session.tx.rates.insertOne({ name: "会话价", inputMiss: 1, inputHit: 1, output: 2 });
	assert.equal(session.isDirty, true, "编辑后应变脏");
	assert.equal(session.schema.rates.some((r) => r.name === "会话价"), true, "工作副本应可见");

	const result = await session.save();
	assert.equal(result.ok, true, "应保存成功");
	assert.equal(session.isDirty, false, "保存后应回净");
	assert.ok(readPricing(path).rates.some((r) => r.name === "会话价"), "应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("PricingSession：reset 丢弃未保存改动并重读磁盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const session = new PricingSession(path);
	session.tx.rates.insertOne({ name: "将被丢弃", inputMiss: 1, inputHit: 1, output: 1 });
	assert.equal(session.isDirty, true);
	session.reset();
	assert.equal(session.isDirty, false, "重置后应回净");
	assert.equal(session.schema.rates.some((r) => r.name === "将被丢弃"), false, "工作副本应丢弃");
	assert.equal(readPricing(path).rates.some((r) => r.name === "将被丢弃"), false, "磁盘不应有");
	rmSync(dir, { recursive: true, force: true });
});

test("PricingSession：悬空引用导致 save 失败，不落盘且仍为脏", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const session = new PricingSession(path);
	session.tx.rules.insertOne({
		name: "坏规则",
		rateId: "ffffffffffffffff",
		timezone: "Asia/Shanghai",
		weekdays: [],
		ranges: [],
		includeCalendars: [],
		excludeCalendars: [],
		includeDates: [],
		excludeDates: [],
	});
	const result = await session.save();
	assert.equal(result.ok, false, "应拒绝落盘");
	assert.ok(result.reason.length > 0, "应返回原因");
	assert.equal(session.isDirty, true, "失败后仍应为脏（改动保留）");
	assert.equal(readPricing(path).rules.some((r) => r.name === "坏规则"), false, "磁盘不应有坏规则");
	rmSync(dir, { recursive: true, force: true });
});
