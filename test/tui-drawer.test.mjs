/**
 * 抽屉测试：根页模型列表、模型详情（选方案 / 开关 / 删除）、保存与重置、两段式 Esc、直达页。
 *
 * 用 mock ctx.ui.custom 捕获工厂，手动构造组件并投喂真实按键序列。
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

const { openPricingDrawer } = await jiti.import(`${SRC}/tui/pricing-drawer.ts`);
const { readPricing } = await jiti.import(`${SRC}/pricing-store.ts`);
const { stripTerminalSequences, visibleWidth } = await import("@earendil-works/pi-tui");

const theme = { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t };
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const CTRL_S = "\x13";
const CTRL_R = "\x12";

function tmpDir() {
	return mkdtempSync(join(tmpdir(), "pi-pricer-drawer-"));
}

/** mock ctx：捕获 custom 的工厂；openPricingDrawer 会 await custom，工厂由测试手动调用 */
function makeCtx() {
	let factory = null;
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (f) => {
				factory = f;
				return undefined;
			},
			notify: () => {},
		},
	};
	return { ctx, factory: () => factory };
}

/** 打开抽屉并返回组件 + done 收集 */
async function open(filePath, initial) {
	return openWith(filePath, { initial });
}

/** 带额外选项打开抽屉 */
async function openWith(filePath, options) {
	const { ctx, factory } = makeCtx();
	await openPricingDrawer(ctx, { filePath, ...options });
	const doneResults = [];
	const component = factory()({}, theme, {}, (value) => doneResults.push(value));
	return { component, doneResults };
}

/** 渲染成纯文本（去 ANSI 由直通主题保证） */
function text(component) {
	return component.render(80).join("\n");
}

/** 当前选中行的文本 */
function selectedLine(component) {
	return component.render(80).find((line) => line.startsWith("▶")) ?? "";
}

/** 仅页面主体（排除抽屉底部的「状态栏 + 底边框」两行） */
function body(component) {
	return component.render(80).slice(0, -2).join("\n");
}

/** 等待落盘完成（轮询状态栏出现"已保存"），避免固定 sleep 在并行负载下抖动 */
async function settle(component, timeout = 1000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (text(component).includes("✓ 已保存")) return;
		await new Promise((r) => setTimeout(r, 5));
	}
}

/** 向下移动到包含 marker 的选中行，达标返回 true */
function moveTo(component, marker, max = 30) {
	for (let i = 0; i < max; i += 1) {
		if (selectedLine(component).includes(marker)) return true;
		component.handleInput(DOWN);
	}
	return selectedLine(component).includes(marker);
}

const BACKSPACE = "\x7f";

test("抽屉：非 TUI 返回 false", async () => {
	const ctx = { mode: "print", ui: { custom: async () => undefined } };
	assert.equal(await openPricingDrawer(ctx, {}), false, "非 TUI 不应开抽屉");
});

test("抽屉：根页只列模型（字母序）；四张管理表由参数直达", async () => {
	const dir = tmpDir();
	const { component } = await open(join(dir, "m.json"));
	const lines = component.render(80);
	const out = lines.join("\n");
	const order = ["deepseek-v4-flash@deepseek", "deepseek-v4-pro@deepseek", "glm-5.3-flash@zai"];
	const positions = order.map((label) => out.indexOf(label));
	assert.deepEqual(positions, [...positions].sort((a, b) => a - b), "模型应字母序");
	// 面包屑：顶边框 → 面包屑 → 空行；根页面包屑为「模型」
	assert.ok(lines[0].includes("─"), "第一行应是顶边框");
	assert.ok(lines[1].includes("模型") && !lines[1].includes("deepseek"), "第二行应是根页面包屑");
	assert.equal(lines[2], "", "面包屑下方应有一个空行");
	// 列对齐：两个数据行的方案列起始位置应一致
	const rowFlash = lines.find((line) => line.includes("deepseek-v4-flash@deepseek"));
	const rowGlm = lines.find((line) => line.includes("glm-5.3-flash@zai"));
	assert.equal(rowFlash.indexOf("→"), rowGlm.indexOf("→"), "方案列应对齐");
	// 「＋添加」上方空行
	const addIndex = lines.findIndex((line) => line.includes("＋添加新的模型计费"));
	assert.equal(lines[addIndex - 1], "", "添加按钮上方应有一个空行");
	for (const title of ["价格表", "日历表", "规则表", "方案表"]) {
		assert.ok(!out.includes(title), `根页不应再出现管理入口 ${title}`);
	}	assert.ok(out.includes("✓ 已保存"), "状态栏应显示已保存");
	// 状态栏在抽屉框内：倒数第二行是状态，最后一行是底边框
	assert.ok(lines[lines.length - 2].includes("✓ 已保存"), "状态栏应在底边框之上");
	assert.ok(lines[lines.length - 1].includes("─"), "最后一行应是抽屉底边框");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：模型详情禁用该模型（仅影响本模型） / 删除方案", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path);

	component.handleInput(ENTER); // 进入首行（字母序：deepseek-flash@deepseek）
	let detail = text(component);
	assert.ok(detail.includes("方案：deepseek-v4-flash 方案"), "应显示当前方案");
	assert.ok(!detail.includes("规则"), "模型详情不应出现规则管理");
	assert.ok(detail.includes("禁用该模型"), "应可禁用模型");

	component.handleInput(DOWN); // 移到开关项
	component.handleInput(ENTER); // 禁用模型
	detail = text(component);
	assert.ok(detail.includes("启用该模型"), "应变为可启用");
	assert.ok(text(component).includes("● 未保存改动"), "应标记未保存");

	component.handleInput(CTRL_S);
	await settle(component);
	const saved = readPricing(path).models.find((m) => m.model === "deepseek-flash");
	assert.equal(saved.enabled, false, "模型启停应落盘");

	// 同方案的别名模型不受影响
	const sibling = readPricing(path).models.find((m) => m.model === "deepseek-v4-flash");
	assert.equal(sibling.enabled, true, "同方案其它模型不受影响");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：新增模型计费（检索 → 选方案）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const availableModels = [
		{ provider: "deepseek", id: "deepseek-v4-flash" },
		{ provider: "acme", id: "acme-1" },
	];
	const { component } = await openWith(path, { availableModels });

	assert.ok(moveTo(component, "＋添加新的模型计费"), "应有添加入口");
	component.handleInput(ENTER);
	for (const ch of "acme") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("acme-1@acme"), "搜索结果应含 acme-1");
	component.handleInput(ENTER); // 选中 → 选方案页
	assert.ok(text(component).includes("选择方案"), "应进入选方案页");
	component.handleInput(ENTER); // 选第一个方案

	component.handleInput(CTRL_S);
	await settle(component);
	const created = readPricing(path).models.find((m) => m.provider === "acme" && m.model === "acme-1");
	assert.ok(created, "新模型绑定应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：检索模型结果分页（每页 8 条，PgUp/PgDn 翻页）", async () => {
	const dir = tmpDir();
	const availableModels = Array.from({ length: 20 }, (_, i) => ({
		provider: "acme",
		id: `m-${String(i).padStart(2, "0")}`,
	}));
	const { component } = await openWith(join(dir, "m.json"), { availableModels });
	assert.ok(moveTo(component, "＋添加新的模型计费"));
	component.handleInput(ENTER); // 打开关键字弹窗
	component.handleInput(ENTER); // 留空 → 全部
	let lines = component.render(80);
	assert.ok(lines.some((line) => line === "  第 1/3 页"), "分页统计应在列表下方");
	assert.equal(lines.filter((line) => line.includes("@acme") && !line.includes("模型计费")).length, 8, "每页 8 条");
	component.handleInput("\x1b[6~"); // PageDown
	lines = component.render(80);
	assert.ok(lines.some((line) => line.startsWith("▶") && line.includes("m-08@acme")), "PgDn 应翻到第二页");
	assert.ok(lines.some((line) => line === "  第 2/3 页"), "页码应更新");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：方案页给方案添加模型；已绑其它方案则拒绝", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const availableModels = [
		{ provider: "acme", id: "acme-2" },
		{ provider: "deepseek", id: "deepseek-v4-pro" },
	];
	const { component } = await openWith(path, { initial: "plan", availableModels });

	assert.ok(moveTo(component, "deepseek-v4-flash 方案"), "应能找到方案");
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "引用此方案的模型"), "应能找到反向引用项");
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "＋添加模型"), "应有添加模型入口");
	component.handleInput(ENTER);
	for (const ch of "acme") component.handleInput(ch);
	component.handleInput(ENTER);
	component.handleInput(ENTER); // 选中 acme-2 → 绑定
	assert.ok(body(component).includes("acme/acme-2"), "模型应加入列表");

	// 已绑其它方案的模型 → 拒绝
	assert.ok(moveTo(component, "＋添加模型"));
	component.handleInput(ENTER);
	for (const ch of "deepseek-v4-pro") component.handleInput(ch);
	component.handleInput(ENTER);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("已绑定方案"), "应拒绝改绑并提示");

	component.handleInput(CTRL_S);
	await settle(component);
	assert.ok(
		readPricing(path).models.some((m) => m.provider === "acme" && m.model === "acme-2"),
		"新绑定应落盘",
	);
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：更换方案改绑并落盘；Ctrl+R 丢弃改动", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path);

	assert.ok(moveTo(component, "deepseek-v4-flash@deepseek"), "应定位到 deepseek-v4-flash");
	component.handleInput(ENTER); // 进入模型
	component.handleInput(ENTER); // 进入"方案"项 → 选择方案页
	const chooser = text(component);
	assert.ok(chooser.includes("选择方案"), "应进入选择方案页");
	// 选择 glm 的方案（列表里第 3 个）
	component.handleInput(DOWN);
	component.handleInput(DOWN);
	component.handleInput(ENTER);

	const after = text(component);
	assert.ok(after.includes("方案：glm-5.3-flash 方案"), "应已改绑");
	component.handleInput(CTRL_S);
	await settle(component);
	assert.equal(
		readPricing(path).models.find((m) => m.model === "deepseek-v4-flash").planId,
		readPricing(path).plans.find((p) => p.name.includes("glm-5.3-flash"))._id,
		"改绑应落盘",
	);

	// 再改一次，用 Ctrl+R 丢弃
	component.handleInput(ENTER); // 进入"方案"
	component.handleInput(DOWN);
	component.handleInput(DOWN);
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("● 未保存改动"), "应有未保存改动");
	component.handleInput(CTRL_R);
	assert.ok(text(component).includes("✓ 已保存"), "重置后应回净");
	assert.equal(
		readPricing(path).models.find((m) => m.model === "deepseek-v4-flash").planId,
		readPricing(path).plans.find((p) => p.name.includes("glm-5.3-flash"))._id,
		"重置后磁盘保持上次保存值",
	);
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：根页脏改动 Esc 两段式（先提示、再次退出）", async () => {
	const dir = tmpDir();
	const { component, doneResults } = await open(join(dir, "m.json"));

	// 制造脏改动：进入模型 → 停用
	component.handleInput(ENTER);
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	component.handleInput(ESC); // 回到根页
	component.handleInput(ESC); // 第一次：提示
	assert.equal(doneResults.length, 0, "首次 Esc 不应退出");
	assert.ok(text(component).includes("有未保存改动"), "应提示未保存");
	component.handleInput(ESC); // 第二次：退出
	assert.deepEqual(doneResults, [true], "再次 Esc 应退出");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：initial=rate 直达价格页（面包屑 模型 › 价格）", async () => {
	const dir = tmpDir();
	const { component } = await open(join(dir, "m.json"), "rate");
	const lines = component.render(80);
	assert.ok(lines[1].includes("模型") && lines[1].includes("价格"), "面包屑应为 模型 › 价格");
	assert.ok(text(component).includes("＋新建价格"), "应直达价格页");
	component.handleInput(ESC);
	assert.ok(component.render(80)[1].includes("模型"), "Esc 应回到模型列表");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：深层面包屑折叠（丢最左祖先，保留末 N 段，当前位置永不隐藏）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "models");
	// 用假页把栈推到 5 级（真实导航到不了这么深）：模型 › 价格 › 规则 › 规则详情 › 编辑星期
	for (const title of ["价格", "规则", "规则详情", "编辑星期"]) {
		component.pages.push({ render: () => [], handleInput: () => {}, title: () => title });
	}
	const crumbAt = (width) => component.render(width)[1];

	// 宽度够：全量展示，无折叠标记
	const wide = crumbAt(80);
	assert.ok(wide.includes("模型") && wide.includes("编辑星期"), "宽屏应显示全链");
	assert.ok(!wide.includes("…"), "宽屏不应折叠");

	// 中等宽度：保留末 2 段 + …，首段（模型）被丢掉，而不是把中间层砍成 3 级
	const mid = crumbAt(30);
	assert.ok(mid.includes("…"), "窄屏应有折叠标记");
	assert.ok(mid.includes("规则详情") && mid.includes("编辑星期"), "应保留末两段（不硬编码 3 级）");
	assert.ok(!mid.includes("模型") && !mid.includes("价格"), "被丢的应是最左祖先");
	assert.equal(mid.split("›").length, 3, "… 加末两段共 3 个条目");
	assert.ok(visibleWidth(mid) <= 30, "不得超宽");

	// 极窄：末级本身放不下 → 截断末级文字，但当前位置仍在（行尾为 …）
	const narrow = stripTerminalSequences(crumbAt(12));
	assert.ok(narrow.includes("编") && narrow.endsWith("…"), "极窄应截断末级文字");
	assert.ok(visibleWidth(narrow) <= 12, "极窄不得超宽");

	// 更窄：连「… › 」都放不下 → 只截断末级，不含分隔符
	const tiny = stripTerminalSequences(crumbAt(6));
	assert.ok(!tiny.includes("›") && tiny.includes("编"), "极窄应放弃折叠标记，只留末级");
	assert.ok(visibleWidth(tiny) <= 6, "极窄不得超宽");
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：面包屑层级 / 超宽折叠 / 弹窗期间隐藏", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "plan");

	// 直达：模型 › 方案
	let crumb = component.render(80)[1];
	assert.ok(crumb.includes("模型") && crumb.includes("方案"), "直达面包屑应为 模型 › 方案");

	// 进入方案详情 → 三级
	assert.ok(moveTo(component, "deepseek-v4-flash 方案"));
	component.handleInput(ENTER);
	crumb = component.render(80)[1];
	assert.ok(crumb.includes("模型") && crumb.includes("方案") && crumb.includes("deepseek-v4-flash 方案"), "应显示三级面包屑");

	// 进入「引用此方案的模型」→ 四级
	assert.ok(moveTo(component, "引用此方案的模型"));
	component.handleInput(ENTER);
	crumb = component.render(80)[1];
	assert.ok(crumb.includes("引用此方案的模型"), "末级应为引用此方案的模型");

	// 超宽折叠：窄宽度下出现省略号
	assert.ok(component.render(28)[1].includes("…"), "窄宽度应折叠中间层");

	// 输入也是子页：面包屑照常加深（不再顶掉层级）
	component.handleInput(ESC); // 回方案详情
	assert.ok(moveTo(component, "重命名该方案"));
	component.handleInput(ENTER); // 压入「重命名」输入子页
	const inputPage = component.render(80);
	assert.ok(inputPage[1].includes("›"), "面包屑层级应保留");
	assert.ok(inputPage[1].includes("重命名"), "输入子页应出现在面包屑末级");
	assert.equal(inputPage.filter((line) => line.includes("Enter 提交")).length, 1, "键位提示只在底栏出现一次");
	assert.ok(inputPage[inputPage.length - 1].includes("─"), "底边框应存在");
	assert.ok(inputPage[inputPage.length - 2].includes("Enter 提交"), "状态栏应紧贴底边框（在框内）");
	component.handleInput(ESC); // 返回方案详情
	assert.ok(!component.render(80)[1].includes("重命名"), "Esc 应退回上一层");
	rmSync(dir, { recursive: true, force: true });
});

test("价格页：列表 + 新建；改数值就地校验并落盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "rate");
	assert.ok(text(component).includes("DeepSeek-v4-flash 谷价"), "应列出已有价格");

	// 新建价格（列表页动态反映）
	assert.ok(moveTo(component, "＋新建价格"), "应能找到新建入口");
	component.handleInput(ENTER);
	for (const ch of "促销价") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("促销价"), "新建后列表应出现新价格");

	// 打开价格详情改输出价
	assert.ok(moveTo(component, "促销价"), "应能选中新价格");
	component.handleInput(ENTER);
	assert.ok(text(component).includes("输出价：0"), "应显示初值");
	assert.ok(moveTo(component, "输出价"), "应能选中输出价");
	component.handleInput(ENTER);
	assert.ok(text(component).includes("编辑输出价"), "应进入输入子页");
	assert.ok(text(component).includes("注：单位：¥ / 百万 token"), "应带单位脚注");
	component.handleInput(BACKSPACE); // 清掉预填的 0
	for (const ch of "3.5") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("输出价：3.5"), "应更新显示");

	component.handleInput(CTRL_S);
	await settle(component);
	assert.equal(readPricing(path).rates.find((r) => r.name === "促销价").output, 3.5, "应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("价格页：非法数值被拦截（不关窗、不丢输入）", async () => {
	const dir = tmpDir();
	const { component } = await open(join(dir, "m.json"), "rate");
	assert.ok(moveTo(component, "DeepSeek-v4-flash 谷价"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "输出价"));
	component.handleInput(ENTER);
	component.handleInput(BACKSPACE);
	for (const ch of "abc") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("✗ 必须是数字"), "应显示错误且不关窗");
	component.handleInput(ESC);
	assert.ok(text(component).includes("输出价：4"), "取消后值不变");
	rmSync(dir, { recursive: true, force: true });
});

test("价格页：删除被规则引用时拒绝并提示", async () => {
	const dir = tmpDir();
	const { component } = await open(join(dir, "m.json"), "rate");
	assert.ok(moveTo(component, "DeepSeek-v4-flash 谷价"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "删除该价格"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "确认执行"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("仍被规则"), "应提示引用保护原因");
	rmSync(dir, { recursive: true, force: true });
});

test("规则页：列表 + 新建（名称 → 选价格）", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "rule");
	assert.ok(text(component).includes("DeepSeek-v4-flash 工作日高峰"), "应列出已有规则");

	assert.ok(moveTo(component, "＋新建规则"));
	component.handleInput(ENTER);
	for (const ch of "测试规则") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("选择价格"), "应进入选价格页");
	component.handleInput(ENTER); // 选第一个价格
	assert.ok(text(component).includes("测试规则"), "新建后列表应出现");
	// 规则表为卡片式：标题一行 + `→ 价格 · 星期 · 时段` 一行；每页 5 条
	assert.ok(text(component).includes("→ DeepSeek-v4-flash 谷价 · 每天 · 全天"), "卡片摘要应含 价格 · 星期 · 时段");
	assert.ok(text(component).includes("第 2/2 页"), "规则表每页 4 条（7 个条目 → 2 页）");
	component.handleInput("\x1b[5~"); // PageUp
	assert.ok(text(component).includes("第 1/2 页"), "PgUp 应回到首页");
	// 「＋新建规则」不参与分页：两页都应常驻，且排在分页统计下方
	assert.ok(text(component).includes("＋新建规则"), "动作条应常驻");
	assert.ok(text(component).indexOf("＋新建规则") > text(component).indexOf("第 1/2 页"), "动作条应在分页下方");
	component.handleInput(CTRL_S);
	await settle(component);
	const created = readPricing(path).rules.find((r) => r.name === "测试规则");
	assert.ok(created, "保存后应落盘");
	assert.equal(created.timezone, "Asia/Shanghai", "默认时区");
	rmSync(dir, { recursive: true, force: true });
});

test("规则详情：星期多选 + 时段增删 + 有效期，并落盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "rule");

	assert.ok(moveTo(component, "DeepSeek-v4-flash 工作日高峰"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("星期：周一 周二 周三 周四 周五"), "应显示当前星期");

	// 改星期：全不选 → 每天
	assert.ok(moveTo(component, "星期："));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("编辑星期"), "应进入星期编辑器（面包屑）");
	component.handleInput(ESC); // 直接保存当前选择
	assert.ok(text(component).includes("星期：周一 周二 周三 周四 周五"), "返回详情");

	// 编辑时段：删掉一条
	assert.ok(moveTo(component, "时段："));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("09:00-12:00"), "应列出现有时段");
	component.handleInput(ENTER); // 删除第一条
	component.handleInput(ESC);
	assert.ok(text(component).includes("时段：14:00-18:00"), "应剩一条时段");

	// 有效期
	assert.ok(moveTo(component, "有效期至"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("留空清除"), "应带格式脚注");
	for (const ch of "2026-12-31") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("2026-12-31"), "应显示有效期");

	component.handleInput(CTRL_S);
	await settle(component);
	const saved = readPricing(path).rules.find((r) => r.name === "DeepSeek-v4-flash 工作日高峰");
	assert.deepEqual(saved.ranges, [["14:00", "18:00"]], "时段应落盘");
	assert.equal(saved.validUntil, "2026-12-31", "有效期应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("规则详情：日历包含切换 + 非法时点拦截 + 删除引用保护", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "rule");

	assert.ok(moveTo(component, "DeepSeek-v4-flash 工作日高峰"));
	component.handleInput(ENTER);

	// 时段非法：起点晚于终点
	assert.ok(moveTo(component, "时段："));
	component.handleInput(ENTER);
	component.handleInput(DOWN); // 移到添加行
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	for (const ch of "18:00-09:00") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("紧点") || text(component).includes("起点必须早于终点"), "应拦截非法时段");
	component.handleInput(ESC);
	component.handleInput(ESC);

	// 删除被方案引用的规则 → 拒绝
	assert.ok(moveTo(component, "删除该规则"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "确认执行"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("仍被方案"), "应提示引用保护原因");
	rmSync(dir, { recursive: true, force: true });
});

test("方案页：列表反向引用 + 新建", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "plan");
	const list = text(component);
	assert.ok(list.includes("deepseek-v4-flash 方案"), "应列出方案");
	assert.ok(list.includes("被 deepseek/deepseek-v4"), "应显示反向引用（截断后仍可辨）");
	assert.ok(list.includes("被 zai/glm-5.3-flash 引用"), "GLM 反向引用应用 pi 真实 provider");

	assert.ok(moveTo(component, "＋新建方案"));
	component.handleInput(ENTER);
	for (const ch of "新策略") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("新策略"), "新建后列表应出现");

	component.handleInput(CTRL_S);
	await settle(component);
	assert.ok(readPricing(path).plans.some((p) => p.name === "新策略"), "应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("方案详情：别名 / 规则增删，并落盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "plan");

	assert.ok(moveTo(component, "deepseek-v4-flash 方案"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("规则（2 条）"), "应显示规则数");
	assert.ok(!text(component).includes("禁用该方案"), "方案详情不应再有启停项");

	// 设别名（弹窗预填原别名，先清空）
	assert.ok(moveTo(component, "别名："), "应能找到别名项");
	component.handleInput(ENTER);
	for (let i = 0; i < 20; i += 1) component.handleInput(BACKSPACE);
	for (const ch of "新HUD") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("别名：新HUD"), "别名应更新");

	// 移出一条规则
	assert.ok(moveTo(component, "规则（2 条）"));
	component.handleInput(ENTER);
	component.handleInput(ENTER); // 移出当前第一条
	assert.ok(!body(component).includes("DeepSeek-v4-flash 全时谷价"), "已移出的规则不应再列出");
	assert.ok(body(component).includes("DeepSeek-v4-flash 工作日高峰"), "剩余规则仍在");
	assert.ok(moveTo(component, "＋添加规则"), "应有添加入口");
	component.handleInput(ESC);

	component.handleInput(CTRL_S);
	await settle(component);
	const saved = readPricing(path).plans.find((p) => p.name === "deepseek-v4-flash 方案");
	assert.equal(saved.alias, "新HUD", "别名应落盘");
	assert.equal(saved.ruleIds.length, 1, "规则增删应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("方案详情：从方案移除模型绑定（删除 ModelDoc）并落盘", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "plan");

	assert.ok(moveTo(component, "deepseek-v4-flash 方案"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "引用此方案的模型"), "应有模型入口");
	component.handleInput(ENTER);
	assert.ok(text(component).includes("deepseek/deepseek-v4-flash"), "应列出已绑定模型");

	assert.ok(moveTo(component, "deepseek/deepseek-v4-flash"));
	component.handleInput(ENTER); // 进入确认页
	assert.ok(text(component).includes("从本方案移除"), "应弹出移除确认");
	assert.ok(moveTo(component, "确认执行"));
	component.handleInput(ENTER);
	assert.ok(!body(component).includes("deepseek/deepseek-v4-flash"), "移除后不应再列出");

	component.handleInput(CTRL_S);
	await settle(component);
	assert.ok(!readPricing(path).models.some((m) => m.model === "deepseek-v4-flash"), "移除应落盘");
	rmSync(dir, { recursive: true, force: true });
});

test("方案页：删除被模型绑定时拒绝", async () => {
	const dir = tmpDir();
	const { component } = await open(join(dir, "m.json"), "plan");
	assert.ok(moveTo(component, "deepseek-v4-flash 方案"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "删除该方案"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "确认执行"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("仍被模型"), "应提示引用保护原因");
	rmSync(dir, { recursive: true, force: true });
});

test("日历页：新建日历 + 日期增删", async () => {
	const dir = tmpDir();
	const path = join(dir, "m.json");
	const { component } = await open(path, "calendar");

	assert.ok(moveTo(component, "＋新建日历"));
	component.handleInput(ENTER);
	for (const ch of "促销日") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("促销日"), "新建后列表应出现");

	assert.ok(moveTo(component, "促销日"));
	component.handleInput(ENTER);
	assert.ok(moveTo(component, "编辑日期"));
	component.handleInput(ENTER);
	assert.ok(text(component).includes("＋添加日期"), "应进入日期编辑");

	component.handleInput(ENTER); // 空列表 → 光标在添加行
	assert.ok(text(component).includes("添加日期"), "应弹出添加弹窗");
	for (const ch of "2026-11-11") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("2026-11-11"), "日期应加入列表");

	// 非法日期被拦截：下移到“添加”行 → 打开弹窗 → 输入非法值
	component.handleInput(DOWN);
	component.handleInput(ENTER);
	for (const ch of "2026-13-99") component.handleInput(ch);
	component.handleInput(ENTER);
	assert.ok(text(component).includes("✗ 日期格式非法"), "非法日期应被拦截");
	component.handleInput(ESC);

	component.handleInput(ESC); // 退回日历详情
	component.handleInput(CTRL_S);
	await settle(component);
	assert.deepEqual(
		readPricing(path).calendars.find((c) => c.name === "促销日").dates,
		["2026-11-11"],
		"应落盘",
	);
	rmSync(dir, { recursive: true, force: true });
});

test("抽屉：所有行都截断到终端宽度（不再撑爆 pi-tui）", async () => {
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const dir = tmpDir();
	const path = join(dir, "m.json");
	// 窄终端 + 五张页面：模型根页（状态栏文案最长）、价格/日历/规则/方案直达页
	for (const initial of ["models", "rate", "calendar", "rule", "plan"]) {
		const { component } = await open(path, initial);
		component.handleInput("a".repeat(40)); // 制造一长串键位无关输入，保持页面稳定
		const width = 40;
		const lines = component.render(width);
		for (const line of lines) {
			assert.ok(
				visibleWidth(line) <= width,
				`${initial} 页存在超宽行（${visibleWidth(line)} > ${width}）：${line}`,
			);
		}
	}
	rmSync(dir, { recursive: true, force: true });
});
