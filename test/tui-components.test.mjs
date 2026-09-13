/**
 * TUI 组件测试：InputPage 就地校验 / 「注：」脚注 / Esc 返回；星期与条目编辑器交互。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

const { InputPage } = await jiti.import(`${SRC}/tui/pricing-prompt.ts`);
const { WeekdaysEditor, ItemListEditor } = await jiti.import(`${SRC}/tui/pricing-editors.ts`);
const { ActionMenu } = await jiti.import(`${SRC}/tui/pricing-menu.ts`);

/** 直通主题（测试用：不做着色） */
const theme = { fg: (_color, text) => text, bg: (_color, text) => text, bold: (text) => text };

/** 组合多个按键 */
function type(component, text) {
	for (const ch of text) component.handleInput(ch);
}

test("InputPage：标题/注脚，校验失败不离开本页且保留输入", () => {
	const submitted = [];
	const cancelled = [];
	const page = new InputPage(theme, {
		title: "编辑输出价",
		note: "单位：¥ / 百万 token",
		initialValue: "8",
		validate: (value) => (Number.isNaN(Number(value)) ? "必须是数字" : null),
		onSubmit: (value) => submitted.push(value),
		onCancel: () => cancelled.push(true),
	});

	assert.equal(page.title(), "编辑输出价", "标题交给面包屑");
	assert.ok(page.footerHints().includes("Enter 提交"), "键位提示交给底栏");
	const rendered = page.render(40).join("\n");
	assert.ok(rendered.includes("注：单位：¥ / 百万 token"), "注脚应带统一前缀");
	assert.ok(!rendered.includes("─"), "不自绘边框");
	assert.ok(!rendered.includes("Enter 提交"), "不自绘键位提示");

	// 输入非法值并提交 → 出错、不提交、输入保留、仍在同一页
	page.setValue("");
	type(page, "abc");
	page.handleInput("\r");
	assert.deepEqual(submitted, [], "非法值不应提交");
	assert.equal(page.getError(), "必须是数字", "应显示错误");
	assert.equal(page.getValue(), "abc", "输入不应丢失");
	assert.ok(page.render(40).join("\n").includes("✗ 必须是数字"), "错误行应渲染");

	// 继续输入应清除错误
	page.setValue("");
	type(page, "9");
	assert.equal(page.getError(), null, "继续输入应清除错误");

	page.handleInput("\r");
	assert.deepEqual(submitted, ["9"], "合法值应提交");

	page.handleInput("\x1b");
	assert.equal(cancelled.length, 1, "Esc 应返回上一层");
});

test("WeekdaysEditor：Enter 即时切换并回调，Esc 只返回", () => {
	const seen = [];
	let done = 0;
	const editor = new WeekdaysEditor(
		theme,
		[1],
		(next) => seen.push(next),
		() => {
			done += 1;
		},
	);
	assert.ok(editor.footerHints().includes("Esc 返回"), "Esc 语义应为返回");

	// 移到周二并切换 → 即时回调
	editor.handleInput("\x1b[B");
	editor.handleInput("\r");
	assert.deepEqual(seen[seen.length - 1], [1, 2], "Enter 应即时回调 {1,2}");
	editor.handleInput("\x1b");
	assert.equal(done, 1, "Esc 应返回");

	// 再次切换周二 → 取消选择
	const editor2 = new WeekdaysEditor(theme, [1, 2], (next) => seen.push(next), () => {});
	editor2.handleInput("\x1b[B");
	editor2.handleInput("\r");
	assert.deepEqual(seen[seen.length - 1], [1], "应取消周二");
});

test("ItemListEditor：删除条目、末尾添加回调、Esc 返回", () => {
	const removed = [];
	const added = [];
	let done = 0;
	const editor = new ItemListEditor(
		theme,
		"时段",
		["09:00-12:00", "14:00-18:00"],
		"添加时段",
		() => added.push(true),
		(index) => removed.push(index),
		() => {
			done += 1;
		},
	);

	// 删除第一条
	editor.handleInput("\r");
	assert.deepEqual(removed, [0], "应删除第一条");
	editor.setItems(["14:00-18:00"]);

	// 移到末尾"添加"行并触发
	editor.handleInput("\x1b[B");
	editor.handleInput("\x1b[B");
	assert.equal(editor.isOnAddRow(), true, "应停在添加行");
	editor.handleInput("\r");
	assert.deepEqual(added, [true], "应触发添加回调");

	editor.handleInput("\x1b");
	assert.equal(done, 1, "Esc 应返回");
});

test("ActionMenu：标题下空行、＋ 上空行、列对齐、选中行主题色高亮", () => {
	const calls = [];
	const recording = {
		fg: (color, text) => {
			calls.push(["fg", color]);
			return text;
		},
		bg: (color, text) => {
			calls.push(["bg", color]);
			return text;
		},
		bold: (text) => text,
	};
	const dataRow = (id, name, prov, plan, state, stateColor) => ({
		id,
		cells: () => [
			{ align: true, spans: () => [{ text: () => name }, { text: () => `@${prov}`, color: "dim" }] },
			{ align: true, spans: () => [{ text: () => `→ [${plan}]` }] },
			{ spans: () => [{ text: () => `[${state}]`, color: stateColor }] },
		],
		run: () => {},
	});
	const menu = new ActionMenu(
		recording,
		"标题",
		[
			dataRow("a", "aaa", "prov", "p1", "启用", "success"),
			dataRow("b", "bbbbbb", "pr", "plan2", "已禁用", "warning"),
			{ id: "add", label: () => "＋添加", run: () => {} },
		],
		() => {},
	);
	const lines = menu.render(60);
	assert.equal(menu.title(), "标题", "应暴露面包屑标题");
	const rowA = lines.find((l) => l.includes("aaa@prov"));
	const rowB = lines.find((l) => l.includes("bbbbbb@pr"));
	assert.equal(rowA.indexOf("→"), rowB.indexOf("→"), "方案列应对齐");
	const addIndex = lines.findIndex((l) => l.includes("＋添加"));
	assert.equal(lines[addIndex - 1], "", "＋条目前应有空行");
	assert.ok(calls.some(([k, c]) => k === "fg" && c === "accent"), "选中行应用 accent");
	assert.ok(calls.some(([k, c]) => k === "bg" && c === "selectedBg"), "选中行应用 selectedBg 背景");
	assert.ok(calls.some(([k, c]) => k === "fg" && c === "warning"), "禁用应用 warning");
	assert.ok(calls.some(([k, c]) => k === "fg" && c === "dim"), "@厂商应用 dim");
	assert.ok(calls.some(([k, c]) => k === "fg" && c === "muted"), "默认文字应用 muted");
	// 移到第二行后，第一行（启用）不再选中，应输出 success 状态色
	menu.handleInput("\x1b[B");
	menu.render(60);
	assert.ok(calls.some(([k, c]) => k === "fg" && c === "success"), "启用应用 success");
});

test("ActionMenu：卡片式条目（标题 + → 摘要 + 条目间空行 + 分页）", () => {
	const menu = new ActionMenu(
		theme,
		"规则",
		Array.from({ length: 7 }, (_, i) => ({
			id: `r${i}`,
			label: () => `规则 ${i}`,
			detail: () => `价 ${i} · 每天 · 全天`,
			run: () => {},
		})),
		() => {},
		undefined,
		5,
		true,
	);
	const lines = menu.render(60);
	assert.equal(lines[0], "▶ 规则 0", "首行是选中条目标题");
	assert.equal(lines[1], "  → 价 0 · 每天 · 全天", "第二行是 `→ 摘要`");
	assert.equal(lines[2], "", "条目之间应空行");
	assert.equal(lines.filter((l) => l.includes("规则 ")).length, 5, "每页 5 条");
	assert.equal(lines[lines.length - 1], "  第 1/2 页", "分页统计应在列表下方");

	menu.handleInput("\x1b[6~"); // PageDown
	assert.ok(menu.render(60)[0].startsWith("▶ 规则 5"), "PgDn 应翻到第二页首条");
});

test("ActionMenu：「＋」动作条不参与分页，且排在分页统计下方", () => {
	const menu = new ActionMenu(
		theme,
		"规则",
		[
			...Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, label: () => `规则 ${i}`, detail: () => `摘要 ${i}`, run: () => {} })),
			{ id: "new", label: () => "＋新建规则", detail: () => "先选价格，再设置时间条件", run: () => {} },
		],
		() => {},
		undefined,
		4,
		true,
	);
	// 5 条规则 → 2 页；分页只数规则，动作条常驻
	let lines = menu.render(60);
	assert.equal(lines.filter((l) => l.startsWith("  → 摘要")).length, 4, "第一页 4 条规则");
	const indexOf = (text) => lines.findIndex((l) => l.includes(text));
	assert.ok(lines.some((l) => l === "  第 1/2 页"), "应显示第 1/2 页");
	assert.ok(lines.some((l) => l.trim() === "＋新建规则"), "动作条应在第一页");
	assert.ok(indexOf("＋新建规则") > indexOf("第 1/2 页"), "动作条应排在分页统计下方");

	menu.handleInput("\x1b[6~"); // PageDown
	lines = menu.render(60);
	assert.ok(lines.some((l) => l === "  第 2/2 页"), "翻页后仍是 2 页（动作条不计入）");
	assert.ok(lines.some((l) => l.trim() === "＋新建规则"), "动作条应常驻第二页");

	// 光标可下移到动作条，进入动作条后仍停留在最后一页
	menu.handleInput("\x1b[B");
	const after = menu.render(60);
	assert.ok(after.some((l) => l === "▶ ＋新建规则"), "光标应能移到动作条");
	assert.ok(after.some((l) => l === "  第 2/2 页"), "停在动作条时仍显示最后一页");
});

test("ActionMenu：分页（每页 8 条，PgUp/PgDn 翻页，上下跨页自动跟随）", () => {
	const menu = new ActionMenu(
		theme,
		"选择模型",
		Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, label: () => `第 ${i} 项`, run: () => {} })),
		() => {},
		undefined,
		8,
	);
	let lines = menu.render(60);
	assert.equal(lines.filter((l) => l.includes("项")).length, 8, "每页应只显示 8 条");
	assert.equal(lines[lines.length - 1], "  第 1/3 页", "分页统计应在列表下方");
	assert.ok(menu.footerHints().includes("PgUp/PgDn 翻页"), "分页时应提示翻页键");

	menu.handleInput("\x1b[6~"); // PageDown
	lines = menu.render(60);
	assert.ok(lines.some((l) => l.startsWith("▶") && l.includes("第 8 项")), "PgDn 应翻到第二页首条");
	assert.equal(lines[lines.length - 1], "  第 2/3 页", "页码应更新");

	menu.handleInput("\x1b[5~"); // PageUp
	lines = menu.render(60);
	assert.ok(lines.some((l) => l.startsWith("▶") && l.includes("第 0 项")), "PgUp 应回到首页首条");

	// 上下移动要能跨页（不再“上下没效果”）
	for (let i = 0; i < 8; i += 1) menu.handleInput("\x1b[B");
	lines = menu.render(60);
	assert.equal(lines[lines.length - 1], "  第 2/3 页", "下移到第 9 条应自动翻页");
});
