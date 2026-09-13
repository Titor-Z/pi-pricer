/**
 * 计费配置抽屉：/price 在 TUI 下的编辑入口。
 *
 * 结构：单组件内维护页面栈（不是 SettingsList 的 submenu 机制，避免其"子菜单接管全部输入"
 * 与"选中项不可外部读写"的限制）。
 * - 根页：只列模型 + “添加新的模型计费”；四张管理表由参数直达
 * - 模型详情：只与方案打交道（选方案 / 启停方案 / 删除方案）
 * - 全局键：Ctrl+S 保存、Ctrl+R 重置；页内 Esc 返回，根页 Esc 两段式（脏改动时先提示）
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PricingSession } from "./pricing-session.ts";
import { InputPage, type UiTheme } from "./pricing-prompt.ts";
import { ActionMenu, type MenuEntry, type MenuSpan } from "./pricing-menu.ts";
import { ItemListEditor, WeekdaysEditor } from "./pricing-editors.ts";
import {
	checkCalendarDeletable,
	checkPlanDeletable,
	checkRateDeletable,
	checkRuleDeletable,
	isValidDateToken,
} from "../db/validate.ts";

/** 星期短名（1=周一 … 7=周日） */
const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];

/** 星期短名（如 2 → "二"） */
function weekdayShort(day: number): string {
	return WEEKDAY_SHORT[day - 1] ?? "";
}

/** 星期集合的展示（空 = 每天） */
function weekdayLabel(days: number[]): string {
	return days.length === 0 ? "每天" : days.map((d) => `周${weekdayShort(d)}`).join(" ");
}

/** 星期集合的紧凑展示（列表摘要用）：空 = 每天，否则 周一二三四五 */
function weekdayCompact(days: number[]): string {
	return days.length === 0 ? "每天" : `周${days.map(weekdayShort).join("")}`;
}

/** 时段的展示（空 = 全天） */
function rangesLabel(ranges: [string, string][]): string {
	return ranges.length === 0 ? "全天" : ranges.map(([s, e]) => `${s}-${e}`).join("/");
}

/** 日期类列表的展示（仅给个数量，避免过长） */
function listLabel(items: string[]): string {
	return items.length === 0 ? "无" : `${items.length} 项`;
}

/** "HH:MM" → 分钟数 */
function minutesOf(hhmm: string): number {
	const [h, m] = hhmm.split(":");
	return Number(h) * 60 + Number(m);
}

/** 时段输入校验：格式 + 起点早于终点 */
function validateRangeToken(value: string): string | null {
	const match = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(value.trim());
	if (!match) return "格式应为 HH:MM-HH:MM";
	return minutesOf(match[1]) >= minutesOf(match[2]) ? "起点必须早于终点（跨天请拆两段）" : null;
}

/** 直达页标识 */
export type DrawerPage = "models" | "rate" | "calendar" | "rule" | "plan";

/** 页面栈中的一页（handleInput 必选，便于统一分发） */
export interface Page {
	/** 只返回内容行（顶边框/面包屑/底边框由抽屉统一渲染） */
	render(width: number): string[];
	handleInput(data: string): void;
	/** 本页在面包屑中的名字 */
	title(): string;
	/** 底部键位提示（由抽屉统一渲染） */
	footerHints?(): string;
	invalidate?(): void;
}

/** 可选模型（来自 pi 模型注册表，供“添加模型计费”检索） */
export interface ModelRef {
	/** 厂商 */
	provider: string;
	/** 模型 id */
	id: string;
}

/** 打开抽屉的选项 */
export interface DrawerOptions {
	/** 初始页（默认模型列表） */
	initial?: DrawerPage;
	/** 注入配置文件路径（测试用） */
	filePath?: string;
	/** 可供选择的模型（pi 模型注册表快照；缺省为空） */
	availableModels?: ModelRef[];
}

/** 计费配置抽屉组件 */
export class PricingDrawer implements Component {
	/** 页面栈（栈顶为当前页） */
	private readonly pages: Page[] = [];

	/** 最近一次操作反馈（保存成功/失败等） */
	private lastMessage = "";

	/** 根页 Esc 是否已提示过（"首次提示、再次退出"状态位） */
	private escHintShown = false;

	/**
	 * 构造抽屉。
	 * @param availableModels 可供添加的模型（来自 pi 模型注册表）
	 */
	constructor(
		private readonly session: PricingSession,
		private readonly theme: UiTheme,
		private readonly done: (result: boolean) => void,
		private readonly options: DrawerOptions = {},
	) {
		this.pages.push(this.buildModelListPage());
		const initial = options.initial ?? "models";
		if (initial === "rate") this.pages.push(this.buildRatePage());
		if (initial === "calendar") this.pages.push(this.buildCalendarPage());
		if (initial === "rule") this.pages.push(this.buildRulePage());
		if (initial === "plan") this.pages.push(this.buildPlanPage());
	}

	// ── 渲染 ──────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const page = this.pages[this.pages.length - 1];
		const dirty = this.session.isDirty ? "● 未保存改动" : "✓ 已保存";
		const feedback = this.lastMessage ? ` · ${this.lastMessage}` : "";
		const hints = page.footerHints?.() ?? "Esc 返回";
		const keys = ` · ${hints} · Ctrl+S 保存 · Ctrl+R 重置`;
		const status = this.theme.fg(this.session.isDirty ? "warning" : "dim", `  ${dirty}${feedback}${keys}`);
		const border = this.theme.fg("borderAccent", "─".repeat(Math.max(1, width)));
		// 统一帧：顶边框 → 面包屑 → 空行 → 页面内容 → 空行 → 状态栏 → 底边框（所有编辑都在子页，无弹窗）
		const lines = [border, this.renderBreadcrumb(width), "", ...page.render(width), "", status, border];
		// 唯一渲染出口：逐行截断到终端宽度，防止自定义内容（含 ANSI）撑爆 pi-tui
		return lines.map((line) => truncateToWidth(line, width));
	}

	/**
	 * 渲染面包屑：页面栈的标题链，末级 accent 加粗。
	 * 超宽时从最左（最老）的祖先开始丢段，保留能放下的末 N 段（N 不设上限），前缀 `…`；
	 * 宽度一律按显示列数（visibleWidth）算。当前位置（末级）永不隐藏，仍放不下则截断末级文字。
	 */
	private renderBreadcrumb(width: number): string {
		const segments = this.pages.map((page) => page.title());
		const available = Math.max(1, width - 2); // 左缩进 2
		const separator = " › ";
		const flag = "… › ";
		const dim = (text: string): string => this.theme.fg("dim", text);
		const style = (text: string, isLast: boolean): string =>
			isLast ? this.theme.fg("accent", this.theme.bold(text)) : dim(text);
		const frame = (list: string[], folded: boolean): string => {
			const parts = list.map((text, index) => style(text, index === list.length - 1));
			const head = folded ? `${dim("…")}${dim(separator)}` : "";
			return `  ${head}${parts.join(dim(separator))}`;
		};

		if (visibleWidth(segments.join(separator)) <= available) return frame(segments, false);

		// 从末级往左贪心纳入（丢最左的祖先）；先给折叠标记留出位置
		const budget = available - visibleWidth(flag);
		const leaf = segments[segments.length - 1];
		// 太窄：连「… › 」都放不下，只能截断末级文字
		if (budget < 1) return `  ${style(truncateToWidth(leaf, available, "…"), true)}`;
		if (visibleWidth(leaf) > budget)
			return `  ${dim("…")}${dim(separator)}${style(truncateToWidth(leaf, budget, "…"), true)}`;
		const kept = [leaf];
		let used = visibleWidth(leaf);
		for (let index = segments.length - 2; index >= 0; index -= 1) {
			const cost = visibleWidth(separator) + visibleWidth(segments[index]);
			if (used + cost > budget) break;
			kept.unshift(segments[index]);
			used += cost;
		}
		return frame(kept, true);
	}

	invalidate(): void {
		for (const page of this.pages) page.invalidate?.();
	}

	// ── 输入 ──────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+s")) {
			void this.save();
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			this.session.reset();
			this.escHintShown = false;
			this.lastMessage = "已重置（丢弃未保存改动）";
			return;
		}
		this.pages[this.pages.length - 1].handleInput(data);
	}

	/** 落盘并把结果写进状态栏 */
	private async save(): Promise<void> {
		const result = await this.session.save();
		this.lastMessage = result.ok ? "保存成功：已写入 ~/.pi/model-pricing.json" : `保存失败：${result.reason}`;
		if (result.ok) this.escHintShown = false;
	}

	// ── 导航 ──────────────────────────────────────────────────────────────

	/** 入栈一页 */
	private push(page: Page): void {
		this.pages.push(page);
	}

	/** 出栈一页；已在根页则忽略 */
	private pop(): void {
		if (this.pages.length > 1) this.pages.pop();
	}

	/** 根页返回：脏改动两段式（首次提示、再次退出） */
	private backFromRoot(): void {
		if (this.session.isDirty && !this.escHintShown) {
			this.escHintShown = true;
			this.lastMessage = "有未保存改动：Ctrl+S 保存 / Ctrl+R 重置；再按 Esc 放弃并退出";
			return;
		}
		this.done(true);
	}

	/** 入栈一个输入子页（提交先回上一层再执行动作，取消直接回上一层） */
	private pushInputPage(options: {
		title: string;
		note?: string;
		placeholder?: string;
		initialValue?: string;
		validate?: (value: string) => string | null;
		onSubmit: (value: string) => void;
	}): void {
		this.push(
			new InputPage(this.theme, {
				...options,
				onSubmit: (value) => {
					this.pop();
					options.onSubmit(value);
				},
				onCancel: () => this.pop(),
			}),
		);
	}

	// ── 根页：模型列表 ────────────────────────────────────────────────────

	/** 模型绑定状态的中文描述（只看方案的启停） */
	private modelState(provider: string, model: string): string {
		const doc = this.session.schema.models.find((m) => m.provider === provider && m.model === model);
		if (!doc) return "未绑定";
		const plan = this.session.schema.plans.find((p) => p._id === doc.planId);
		if (!plan) return "方案缺失";
		return plan.enabled ? "启用" : "已禁用";
	}

	/** 绑定状态对应的语义色（启用绿 / 禁用黄 / 缺失红） */
	private stateColor(provider: string, model: string): string {
		switch (this.modelState(provider, model)) {
			case "启用":
				return "success";
			case "已禁用":
				return "warning";
			case "方案缺失":
				return "error";
			default:
				return "warning";
		}
	}

	/** 根页：只列模型 + 添加入口（三列对齐：模型@厂商 ｜ 方案 ｜ 状态） */
	private buildModelListPage(): Page {
		const ordered = [...this.session.schema.models].sort((a, b) =>
			`${a.model}@${a.provider}`.localeCompare(`${b.model}@${b.provider}`),
		);
		const entries: MenuEntry[] = ordered.map((doc) => ({
			id: `model:${doc.provider}/${doc.model}`,
			cells: () => {
				const plan = this.session.schema.plans.find((p) => p._id === doc.planId);
				const planSpans: MenuSpan[] = plan
					? [
							{ text: () => `→ [${plan.name}` },
							...(plan.alias
								? [{ text: () => `@${plan.alias}]`, color: "dim" }]
								: [{ text: () => "]" }]),
						]
					: [{ text: () => "→ [方案缺失]", color: "error" }];
				const state = this.modelState(doc.provider, doc.model);
				return [
					{
						align: true,
						spans: () => [
							{ text: () => doc.model },
							{ text: () => `@${doc.provider}`, color: "dim" },
						],
					},
					{ align: true, spans: () => planSpans },
					{ spans: () => [{ text: () => `[${state}]`, color: this.stateColor(doc.provider, doc.model) }] },
				];
			},
			run: () => this.push(this.buildModelDetailPage(doc.provider, doc.model)),
		}));
		entries.push({
			id: "model:add",
			label: () => "＋添加新的模型计费",
			detail: () => "检索模型 → 选择或新建方案",
			run: () => this.promptModelSearch((ref) => this.startModelBilling(ref)),
		});
		return new ActionMenu(
			this.theme,
			"模型",
			entries,
			() => this.backFromRoot(),
		);
	}

	/** 检索并选择模型（关键字输入子页 → 匹配列表） */
	private promptModelSearch(onPick: (ref: ModelRef) => void): void {
		this.promptText({
			title: "检索模型",
			note: "按 厂商/模型名 过滤；留空列出全部",
			placeholder: "如 deepseek",
			onSubmit: (keyword) => this.push(this.buildModelSearchResultPage(keyword.trim().toLowerCase(), onPick)),
		});
	}

	/** 检索结果每页条目数（超过则分页，避免撑开抽屉） */
	private static readonly MODEL_PAGE_SIZE = 8;

	/** 模型搜索结果页（分页：每页 8 条，PgUp/PgDn 翻页） */
	private buildModelSearchResultPage(keyword: string, onPick: (ref: ModelRef) => void): Page {
		return new ActionMenu(
			this.theme,
			`选择模型（${keyword || "全部"}）`,
			() => {
				const all = this.options.availableModels ?? [];
				const matches = all.filter((ref) => `${ref.provider}/${ref.id}`.toLowerCase().includes(keyword));
				if (matches.length === 0) {
					return [{ id: "model:none", label: () => "（没有匹配的模型）", run: () => this.pop() }];
				}
				return matches.slice(0, 200).map((ref) => ({
					id: `model:${ref.provider}/${ref.id}`,
					label: () => `${ref.id}@${ref.provider}`,
					run: () => onPick(ref),
				}));
			},
			() => this.pop(),
			undefined,
			PricingDrawer.MODEL_PAGE_SIZE,
		);
	}

	/** 开始为某模型建立计费：已有配置则拒绝，否则选/建方案 */
	private startModelBilling(ref: ModelRef): void {
		const existing = this.session.schema.models.find((m) => m.provider === ref.provider && m.model === ref.id);
		if (existing) {
			this.lastMessage = `${ref.provider}/${ref.id} 已有计费配置（请到该模型里改方案）`;
			this.pop();
			return;
		}
		this.push(this.buildBindNewModelPage(ref));
	}

	/** 为新模型选方案（或新建方案）的页面 */
	private buildBindNewModelPage(ref: ModelRef): Page {
		return new ActionMenu(
			this.theme,
			`${ref.id}@${ref.provider} · 选择方案`,
			() => [
				...this.session.schema.plans.map((plan) => ({
					id: `plan:${plan._id}`,
					label: () => `${plan.enabled ? "◉" : "◌"} ${plan.name}${plan.alias ? `（${plan.alias}）` : ""}`,
					detail: () => `${plan.ruleIds.length} 条规则`,
					run: () => {
						this.session.tx.models.insertOne({ provider: ref.provider, model: ref.id, planId: plan._id });
						this.lastMessage = `已为 ${ref.provider}/${ref.id} 绑定方案「${plan.name}」`;
						this.pop(); // 回搜索结果
						this.pop(); // 回根页
					},
				})),
				{
					id: "plan:new",
					label: () => "＋新建方案并绑定",
					detail: () => "创建空方案后进入配置",
					run: () => this.createPlanForModel(ref),
				},
			],
			() => this.pop(),
		);
	}

	/** 新建方案并绑定给模型，然后进入方案配置 */
	private createPlanForModel(ref: ModelRef): void {
		this.promptText({
			title: "新建方案",
			note: "名称全表唯一；创建后进入方案配置",
			placeholder: "如：2026.8 价格方案",
			validate: (value) => this.validateNewName("plans", value),
			onSubmit: (name) => {
				const plan = this.session.tx.plans.insertOne({ name: name.trim(), enabled: true, ruleIds: [] });
				this.session.tx.models.insertOne({ provider: ref.provider, model: ref.id, planId: plan._id });
				this.lastMessage = `已新建方案「${name.trim()}」并绑定`;
				this.pop(); // 回搜索结果
				this.pop(); // 回根页
				this.push(this.buildPlanDetailPage(plan._id));
			},
		});
	}

	// ── 模型详情：只与方案打交道 ──────────────────────────────────────────

	/** 模型详情页：选方案 / 禁用方案 / 删除方案 */
	private buildModelDetailPage(provider: string, model: string): Page {
		const findModel = () => this.session.schema.models.find((m) => m.provider === provider && m.model === model);
		const currentPlan = () => {
			const doc = findModel();
			return doc ? this.session.schema.plans.find((p) => p._id === doc.planId) : undefined;
		};
		const entries = [
			{
				id: "detail:choose-plan",
				label: () => `方案：${currentPlan()?.name ?? "（方案缺失）"}`,
				detail: () => {
					const plan = currentPlan();
					return plan?.alias ? `别名 ${plan.alias}｜Enter 更换方案` : "Enter 更换方案";
				},
				run: () => this.push(this.buildPlanChooserPage(provider, model)),
			},
			{
				id: "detail:toggle",
				label: () => (currentPlan()?.enabled ? "禁用该方案" : "启用该方案"),
				detail: () => `当前：${this.modelState(provider, model)}`,
				run: () => {
					const plan = currentPlan();
					if (plan) this.session.tx.plans.updateOne(plan._id, { enabled: !plan.enabled });
				},
			},
			{
				id: "detail:delete",
				label: () => "删除该方案",
				detail: () => "若有其它模型在用该方案会被拒绝",
				run: () => this.push(this.buildConfirmPage(
					`删除方案「${currentPlan()?.name ?? ""}」？`,
					() => {
						const plan = currentPlan();
						const doc = findModel();
						if (!plan || !doc) { this.pop(); return; }
						const others = this.session.schema.models.filter((m) => m.planId === plan._id && m._id !== doc._id);
						if (others.length > 0) {
							this.lastMessage = `方案「${plan.name}」仍被 ${others.map((m) => `${m.provider}/${m.model}`).join("、")} 引用，不能删除`;
							this.pop();
							return;
						}
						// 仅本模型使用：删除方案与模型文档（v5 模型必须绑方案）
						this.session.tx.plans.deleteOne(plan._id);
						this.session.tx.models.deleteOne(doc._id);
						this.pop(); // 回模型详情
						this.pop(); // 回根页
						this.lastMessage = `已删除方案「${plan.name}」及其模型计费`;
					},
				)),
			},
		];
		return new ActionMenu(
			this.theme,
			`${model}@${provider}`,
			entries,
			() => this.pop(),
		);
	}

	/** 选择方案页（改绑） */
	private buildPlanChooserPage(provider: string, model: string): Page {
		const entries = this.session.schema.plans.map((plan) => ({
			id: `plan:${plan._id}`,
			label: () => `${plan.enabled ? "◉" : "◌"} ${plan.name}${plan.alias ? `（${plan.alias}）` : ""}`,
			detail: () => `${plan.ruleIds.length} 条规则${plan.enabled ? "" : "｜方案已禁用"}`,
			run: () => {
				const doc = this.session.schema.models.find((m) => m.provider === provider && m.model === model);
				if (doc) this.session.tx.models.updateOne(doc._id, { planId: plan._id });
				this.pop();
			},
		}));
		return new ActionMenu(
			this.theme,
			"选择方案",
			entries,
			() => this.pop(),
		);
	}

	/** 确认页（是 / 否） */
	private buildConfirmPage(question: string, onConfirm: () => void): Page {
		return new ActionMenu(
			this.theme,
			"确认删除",
			[
				{ id: "confirm:yes", label: () => "确认执行", detail: () => question, run: onConfirm },
				{ id: "confirm:no", label: () => "取消", run: () => this.pop() },
			],
			() => this.pop(),
		);
	}

	// ── 管理页（价格/日历/规则/方案） ─────────────────────────────────────
	// ── 输入子页辅助（无弹窗：输入也进面包屑） ───────────

	/** 打开文本输入子页（提交时校验；提交/取消都回上一层） */
	private promptText(options: {
		title: string;
		note?: string;
		placeholder?: string;
		initialValue?: string;
		validate?: (value: string) => string | null;
		onSubmit: (value: string) => void;
	}): void {
		this.pushInputPage(options);
	}

	/** 打开非负数字输入子页 */
	private promptNumber(options: {
		title: string;
		note?: string;
		initialValue?: string;
		onSubmit: (value: number) => void;
	}): void {
		this.promptText({
			title: options.title,
			note: options.note,
			initialValue: options.initialValue,
			validate: (value) => {
				const trimmed = value.trim();
				if (trimmed === "" || Number.isNaN(Number(trimmed))) return "必须是数字";
				return Number(trimmed) < 0 ? "不能为负数" : null;
			},
			onSubmit: (value) => options.onSubmit(Number(value.trim())),
		});
	}

	/** 新名称校验：非空 + 集合内不重名（排除自身） */
	private validateNewName(
		collection: "rates" | "calendars" | "rules" | "plans",
		value: string,
		excludeId?: string,
	): string | null {
		const name = value.trim();
		if (name === "") return "名称不能为空";
		const docs = this.session.schema[collection] as Array<{ _id: string; name: string }>;
		return docs.some((d) => d.name === name && d._id !== excludeId) ? "该名称已存在" : null;
	}

	/** 通用字符串列表编辑器页（时段 / 日期复用）：列表 + 末尾添加 + Enter 删除 */
	private buildStringListPage(config: {
		title: string;
		list: () => string[];
		addTitle: string;
		addNote: string;
		placeholder?: string;
		validate: (value: string) => string | null;
		onAdd: (value: string) => void;
		onRemove: (index: number) => void;
		onDone: () => void;
	}): Page {
		const editor = new ItemListEditor(
			this.theme,
			config.title,
			config.list(),
			config.addTitle,
			() =>
				this.promptText({
					title: config.addTitle,
					note: config.addNote,
					placeholder: config.placeholder,
					validate: config.validate,
					onSubmit: (value) => {
						config.onAdd(value.trim());
						editor.setItems(config.list());
					},
				}),
			(index) => {
				config.onRemove(index);
				editor.setItems(config.list());
			},
			config.onDone,
		);
		return editor;
	}

	// ── 价格表 ────────────────────────────────────────────

	/** 价格表页：列表 + 新建 */
	private buildRatePage(): Page {
		return new ActionMenu(
			this.theme,
			"价格",
			() => [
				...this.session.schema.rates.map((rate) => ({
					id: `rate:${rate._id}`,
					cells: () => [
						{ align: true, spans: () => [{ text: () => rate.name }] },
						{
							spans: () => [
								{
									text: () => `未命中 ${rate.inputMiss} · 命中 ${rate.inputHit} · 输出 ${rate.output}`,
									color: "dim",
								},
							],
						},
					],
					run: () => this.push(this.buildRateDetailPage(rate._id)),
				})),
				{
					id: "rate:new",
					label: () => "＋新建价格",
					detail: () => "先建价格，再在规则中引用",
					run: () => this.createRate(),
				},
			],
			() => this.pop(),
		);
	}

	/** 新建价格（名称唯一） */
	private createRate(): void {
		this.promptText({
			title: "新建价格",
			note: "名称全表唯一；数值稍后在详情页设置",
			placeholder: "如：Pro 谷价",
			validate: (value) => this.validateNewName("rates", value),
			onSubmit: (name) => {
				this.session.tx.rates.insertOne({ name: name.trim(), inputMiss: 0, inputHit: 0, output: 0 });
				this.lastMessage = `已新建价格「${name.trim()}」`;
			},
		});
	}

	/** 价格详情页：改三个数值 / 改名 / 删除 */
	private buildRateDetailPage(rateId: string): Page {
		const find = () => this.session.schema.rates.find((r) => r._id === rateId);
		return new ActionMenu(
			this.theme,
			() => find()?.name ?? "价格",
			() => [
				{ id: "rate:output", label: () => `输出价：${find()?.output ?? ""}`, run: () => this.editRateNumber(rateId, "output", "输出价") },
				{ id: "rate:miss", label: () => `未命中输入价：${find()?.inputMiss ?? ""}`, run: () => this.editRateNumber(rateId, "inputMiss", "未命中输入价") },
				{ id: "rate:hit", label: () => `命中输入价：${find()?.inputHit ?? ""}`, run: () => this.editRateNumber(rateId, "inputHit", "命中输入价") },
				{ id: "rate:rename", label: () => "重命名该价格", run: () => this.renameDoc("rates", rateId) },
				{
					id: "rate:delete",
					label: () => "删除该价格",
					detail: () => "被规则引用时会被拒绝",
					run: () => this.deleteRate(rateId),
				},
			],
			() => this.pop(),
		);
	}

	/** 改价格数值（预填现值 + 非负校验） */
	private editRateNumber(rateId: string, field: "inputMiss" | "inputHit" | "output", title: string): void {
		const rate = this.session.schema.rates.find((r) => r._id === rateId);
		if (!rate) return;
		this.promptNumber({
			title: `编辑${title}`,
			note: "单位：¥ / 百万 token",
			initialValue: String(rate[field]),
			onSubmit: (value) => {
				this.session.tx.rates.updateOne(rateId, { [field]: value });
				this.lastMessage = `已更新「${rate.name}」${title} = ${value}`;
			},
		});
	}

	/** 删除价格（引用保护） */
	private deleteRate(rateId: string): void {
		const rate = this.session.schema.rates.find((r) => r._id === rateId);
		if (!rate) return;
		this.push(
			this.buildConfirmPage(`删除价格「${rate.name}」？`, () => {
				const check = checkRateDeletable(this.session.schema, rateId);
				if (!check.ok) {
					this.lastMessage = check.reason;
					this.pop();
					return;
				}
				this.session.tx.rates.deleteOne(rateId);
				this.pop(); // 回价格详情
				this.pop(); // 回价格表
				this.lastMessage = `已删除价格「${rate.name}」`;
			}),
		);
	}

	// ── 日历表 ────────────────────────────────────────────

	/** 日历表页：列表 + 新建 */
	private buildCalendarPage(): Page {
		return new ActionMenu(
			this.theme,
			"日历",
			() => [
				...this.session.schema.calendars.map((cal) => ({
					id: `calendar:${cal._id}`,
					cells: () => [
						{ align: true, spans: () => [{ text: () => cal.name }] },
						{
							spans: () => [
								{
									text: () => `${cal.dates.length} 个日期：${cal.dates.slice(0, 5).join(", ")}${cal.dates.length > 5 ? " …" : ""}`,
									color: "dim",
								},
							],
						},
					],
					run: () => this.push(this.buildCalendarDetailPage(cal._id)),
				})),
				{
					id: "calendar:new",
					label: () => "＋新建日历",
					detail: () => "如：中国法定节假日、促销日",
					run: () => this.createCalendar(),
				},
			],
			() => this.pop(),
		);
	}

	/** 新建日历（名称唯一，日期先留空） */
	private createCalendar(): void {
		this.promptText({
			title: "新建日历",
			note: "名称全表唯一；日期在详情页添加",
			placeholder: "如：中国法定节假日",
			validate: (value) => this.validateNewName("calendars", value),
			onSubmit: (name) => {
				this.session.tx.calendars.insertOne({ name: name.trim(), dates: [] });
				this.lastMessage = `已新建日历「${name.trim()}」`;
			},
		});
	}

	/** 日历详情页：改名 / 编辑日期 / 删除 */
	private buildCalendarDetailPage(calendarId: string): Page {
		const find = () => this.session.schema.calendars.find((c) => c._id === calendarId);
		return new ActionMenu(
			this.theme,
			() => find()?.name ?? "日历",
			() => [
				{
					id: "calendar:dates",
					label: () => `编辑日期（${find()?.dates.length ?? 0} 个）`,
					detail: () => "Enter 删除选中日期；末尾可添加",
					run: () => this.push(this.buildDatesEditorPage(calendarId)),
				},
				{ id: "calendar:rename", label: () => "重命名该日历", run: () => this.renameDoc("calendars", calendarId) },
				{
					id: "calendar:delete",
					label: () => "删除该日历",
					detail: () => "被规则引用时会被拒绝",
					run: () => this.deleteCalendar(calendarId),
				},
			],
			() => this.pop(),
		);
	}

	/** 日期编辑页（增删） */
	private buildDatesEditorPage(calendarId: string): Page {
		const find = () => this.session.schema.calendars.find((c) => c._id === calendarId);
		return this.buildStringListPage({
			title: "编辑日期",
			list: () => find()?.dates ?? [],
			addTitle: "添加日期",
			addNote: "YYYY-MM-DD 精确 或 MM-DD 每年循环",
			placeholder: "01-01",
			validate: (value) => {
				const token = value.trim();
				if (!isValidDateToken(token)) return "日期格式非法（应为 YYYY-MM-DD 或 MM-DD）";
				return find()?.dates.includes(token) ? "该日期已存在" : null;
			},
			onAdd: (value) => {
				const cal = find();
				if (cal) this.session.tx.calendars.updateOne(cal._id, { dates: [...cal.dates, value.trim()] });
			},
			onRemove: (index) => {
				const cal = find();
				if (cal) this.session.tx.calendars.updateOne(cal._id, { dates: cal.dates.filter((_, i) => i !== index) });
			},
			onDone: () => this.pop(),
		});
	}

	/** 删除日历（引用保护） */
	private deleteCalendar(calendarId: string): void {
		const cal = this.session.schema.calendars.find((c) => c._id === calendarId);
		if (!cal) return;
		this.push(
			this.buildConfirmPage(`删除日历「${cal.name}」？`, () => {
				const check = checkCalendarDeletable(this.session.schema, calendarId);
				if (!check.ok) {
					this.lastMessage = check.reason;
					this.pop();
					return;
				}
				this.session.tx.calendars.deleteOne(calendarId);
				this.pop();
				this.pop();
				this.lastMessage = `已删除日历「${cal.name}」`;
			}),
		);
	}

	// ── 通用改名 ────────────────────────────────────────────

	/** 重命名实体（价格 / 日历 / 规则 / 方案；名称唯一，排除自身） */
	private renameDoc(collection: "rates" | "calendars" | "rules" | "plans", id: string): void {
		const docs = this.session.schema[collection] as Array<{ _id: string; name: string }>;
		const doc = docs.find((d) => d._id === id);
		if (!doc) return;
		this.promptText({
			title: "重命名",
			note: "名称需全表唯一",
			initialValue: doc.name,
			validate: (value) => this.validateNewName(collection, value, id),
			onSubmit: (value) => {
				this.session.tx[collection].updateOne(id, { name: value.trim() } as never);
				this.lastMessage = `已重命名为「${value.trim()}」`;
			},
		});
	}

	// ── 规则表 ────────────────────────────────────────────

	/** 规则表页：卡片式（规则名 + `→ 价格 · 星期 · 时段`），每页 4 条 */
	private buildRulePage(): Page {
		return new ActionMenu(
			this.theme,
			"规则",
			() => [
				...this.session.schema.rules.map((rule) => ({
					id: `rule:${rule._id}`,
					label: () => rule.name,
					detail: () =>
						`${this.rateNameOf(rule.rateId)} · ${weekdayCompact(rule.weekdays)} · ${rangesLabel(rule.ranges)}`,
					run: () => this.push(this.buildRuleDetailPage(rule._id)),
				})),
				{
					id: "rule:new",
					label: () => "＋新建规则",
					detail: () => "先选价格，再设置时间条件",
					run: () => this.createRule(),
				},
			],
			() => this.pop(),
			undefined,
			PricingDrawer.RULE_PAGE_SIZE,
			true,
		);
	}

	/** 规则表每页条目数（卡片式两行 → 4 条 ≈ 一屏） */
	private static readonly RULE_PAGE_SIZE = 4;

	/** 价格名（用于展示） */
	private rateNameOf(rateId: string): string {
		return this.session.schema.rates.find((r) => r._id === rateId)?.name ?? "（价格缺失）";
	}

	/** 规则时间条件摘要 */
	private ruleScheduleLabel(ruleId: string): string {
		const rule = this.session.schema.rules.find((r) => r._id === ruleId);
		if (!rule) return "";
		const days = rule.weekdays.length === 0 ? "每天" : rule.weekdays.map(weekdayShort).join("");
		const ranges = rule.ranges.length === 0 ? "全天" : rule.ranges.map(([s, e]) => `${s}-${e}`).join("/");
		const extra: string[] = [];
		if (rule.includeCalendars.length > 0) extra.push(`仅 ${this.calendarNames(rule.includeCalendars)}`);
		if (rule.excludeCalendars.length > 0) extra.push(`排 ${this.calendarNames(rule.excludeCalendars)}`);
		if (rule.includeDates.length > 0) extra.push(`指定 ${rule.includeDates.length} 日`);
		if (rule.excludeDates.length > 0) extra.push(`排除 ${rule.excludeDates.length} 日`);
		if (rule.validUntil) extra.push(`至 ${rule.validUntil}`);
		return [`${days} ${ranges}`, ...extra].join(" · ");
	}

	/** 日历 id 列表 → 名称串 */
	private calendarNames(ids: string[]): string {
		return ids
			.map((id) => this.session.schema.calendars.find((c) => c._id === id)?.name ?? "（缺失）")
			.join("、");
	}

	/** 新建规则：名称 → 选价格 */
	private createRule(): void {
		if (this.session.schema.rates.length === 0) {
			this.lastMessage = "请先创建至少一个价格，再新建规则";
			return;
		}
		this.promptText({
			title: "新建规则",
			note: "名称全表唯一；下一步选择引用的价格",
			placeholder: "如：工作日高峰",
			validate: (value) => this.validateNewName("rules", value),
			onSubmit: (name) => this.push(this.buildRuleRateChooserPage(name.trim())),
		});
	}

	/** 选价格页（新建时插入 / 编辑时改引用） */
	private buildRuleRateChooserPage(ruleName: string, ruleId?: string): Page {
		return new ActionMenu(
			this.theme,
			"选择价格",
			() => {
				const rates = this.session.schema.rates;
				if (rates.length === 0) {
					return [{ id: "rate:none", label: () => "（暂无价格，请先去价格表创建）", run: () => this.pop() }];
				}
				return rates.map((rate) => ({
					id: `rate:${rate._id}`,
					label: () => rate.name,
					detail: () => `未命中 ${rate.inputMiss} · 命中 ${rate.inputHit} · 输出 ${rate.output}`,
					run: () => {
						if (ruleId) {
							this.session.tx.rules.updateOne(ruleId, { rateId: rate._id });
							this.lastMessage = `已把规则「${ruleName}」的价格改为「${rate.name}」`;
						} else {
							this.session.tx.rules.insertOne({
								name: ruleName,
								rateId: rate._id,
								timezone: "Asia/Shanghai",
								weekdays: [],
								ranges: [],
								includeCalendars: [],
								excludeCalendars: [],
								includeDates: [],
								excludeDates: [],
							});
							this.lastMessage = `已新建规则「${ruleName}」`;
						}
						this.pop();
					},
				}));
			},
			() => this.pop(),
		);
	}

	/** 规则详情页：价格 / 时区 / 星期 / 时段 / 日历 / 日期 / 有效期 / 改名 / 删除 */
	private buildRuleDetailPage(ruleId: string): Page {
		const find = () => this.session.schema.rules.find((r) => r._id === ruleId);
		return new ActionMenu(
			this.theme,
			() => find()?.name ?? "规则",
			() => [
				{
					id: "rule:rate",
					label: () => {
						const rule = find();
						return `价格：${rule ? this.rateNameOf(rule.rateId) : ""}`;
					},
					detail: () => "Enter 更换引用的价格",
					run: () => this.push(this.buildRuleRateChooserPage(find()?.name ?? "", ruleId)),
				},
				{
					id: "rule:tz",
					label: () => `时区：${find()?.timezone ?? ""}`,
					run: () => this.editRuleTimezone(ruleId),
				},
				{
					id: "rule:weekdays",
					label: () => `星期：${weekdayLabel(find()?.weekdays ?? [])}`,
					run: () => this.editRuleWeekdays(ruleId),
				},
				{
					id: "rule:ranges",
					label: () => `时段：${rangesLabel(find()?.ranges ?? [])}`,
					run: () => this.push(this.buildRuleRangesPage(ruleId)),
				},
				{
					id: "rule:inc-cal",
					label: () => `包含日历：${this.calendarNames(find()?.includeCalendars ?? []) || "无"}`,
					run: () => this.push(this.buildCalendarTogglePage(ruleId, "include")),
				},
				{
					id: "rule:exc-cal",
					label: () => `排除日历：${this.calendarNames(find()?.excludeCalendars ?? []) || "无"}`,
					run: () => this.push(this.buildCalendarTogglePage(ruleId, "exclude")),
				},
				{
					id: "rule:inc-dates",
					label: () => `指定日期：${listLabel(find()?.includeDates ?? [])}`,
					run: () => this.push(this.buildRuleDatesPage(ruleId, "includeDates")),
				},
				{
					id: "rule:exc-dates",
					label: () => `排除日期：${listLabel(find()?.excludeDates ?? [])}`,
					run: () => this.push(this.buildRuleDatesPage(ruleId, "excludeDates")),
				},
				{
					id: "rule:valid",
					label: () => `有效期至：${find()?.validUntil ?? "无"}`,
					detail: () => "留空可清除",
					run: () => this.editRuleValidUntil(ruleId),
				},
				{ id: "rule:rename", label: () => "重命名该规则", run: () => this.renameDoc("rules", ruleId) },
				{
					id: "rule:delete",
					label: () => "删除该规则",
					detail: () => "被方案引用时会被拒绝",
					run: () => this.deleteRule(ruleId),
				},
			],
			() => this.pop(),
		);
	}

	/** 改规则时区 */
	private editRuleTimezone(ruleId: string): void {
		const rule = this.session.schema.rules.find((r) => r._id === ruleId);
		if (!rule) return;
		this.promptText({
			title: "编辑时区",
			note: "IANA 名称，如 Asia/Shanghai",
			initialValue: rule.timezone,
			validate: (value) => (value.trim() === "" ? "时区不能为空" : null),
			onSubmit: (value) => {
				this.session.tx.rules.updateOne(ruleId, { timezone: value.trim() });
				this.lastMessage = `已设置时区 ${value.trim()}`;
			},
		});
	}

	/** 改规则星期（多选编辑器） */
	private editRuleWeekdays(ruleId: string): void {
		const rule = this.session.schema.rules.find((r) => r._id === ruleId);
		if (!rule) return;
		this.push(
			new WeekdaysEditor(
				this.theme,
				rule.weekdays,
				(next) => {
					this.session.tx.rules.updateOne(ruleId, { weekdays: next });
					this.lastMessage = `已设置星期：${weekdayLabel(next)}`;
				},
				() => this.pop(),
			),
		);
	}

	/** 规则时段编辑页 */
	private buildRuleRangesPage(ruleId: string): Page {
		const find = () => this.session.schema.rules.find((r) => r._id === ruleId);
		return this.buildStringListPage({
			title: "编辑时段",
			list: () => (find()?.ranges ?? []).map(([s, e]) => `${s}-${e}`),
			addTitle: "添加时段",
			addNote: "HH:MM-HH:MM（半开区间，含头不含尾；跨天拆两段）",
			placeholder: "09:00-12:00",
			validate: (value) => validateRangeToken(value),
			onAdd: (value) => {
				const rule = find();
				if (!rule) return;
				const [s, e] = value.trim().split("-");
				this.session.tx.rules.updateOne(ruleId, { ranges: [...rule.ranges, [s, e] as [string, string]] });
			},
			onRemove: (index) => {
				const rule = find();
				if (rule) this.session.tx.rules.updateOne(ruleId, { ranges: rule.ranges.filter((_, i) => i !== index) });
			},
			onDone: () => this.pop(),
		});
	}

	/** 规则日历包含/排除切换页 */
	private buildCalendarTogglePage(ruleId: string, mode: "include" | "exclude"): Page {
		const field = mode === "include" ? "includeCalendars" : "excludeCalendars";
		const find = () => this.session.schema.rules.find((r) => r._id === ruleId);
		return new ActionMenu(
			this.theme,
			mode === "include" ? "切换包含日历" : "切换排除日历",
			() => {
				const calendars = this.session.schema.calendars;
				if (calendars.length === 0) {
					return [{ id: "cal:none", label: () => "（暂无日历，请先去日历表创建）", run: () => this.pop() }];
				}
				return calendars.map((cal) => {
					const selected = () => find()?.[field].includes(cal._id) ?? false;
					return {
						id: `cal:${cal._id}`,
						label: () => `${selected() ? "◉" : "◌"} ${cal.name}`,
						detail: () => `${cal.dates.length} 个日期｜Enter 切换`,
						run: () => {
							const rule = find();
							if (!rule) return;
							const next = selected()
								? rule[field].filter((id) => id !== cal._id)
								: [...rule[field], cal._id];
							this.session.tx.rules.updateOne(ruleId, { [field]: next });
						},
					};
				});
			},
			() => this.pop(),
		);
	}

	/** 规则指定/排除日期编辑页 */
	private buildRuleDatesPage(ruleId: string, field: "includeDates" | "excludeDates"): Page {
		const find = () => this.session.schema.rules.find((r) => r._id === ruleId);
		return this.buildStringListPage({
			title: field === "includeDates" ? "编辑指定日期" : "编辑排除日期",
			list: () => find()?.[field] ?? [],
			addTitle: "添加日期",
			addNote: "YYYY-MM-DD 精确 或 MM-DD 每年循环",
			placeholder: "2026-11-11",
			validate: (value) => {
				const token = value.trim();
				if (!isValidDateToken(token)) return "日期格式非法（应为 YYYY-MM-DD 或 MM-DD）";
				return find()?.[field].includes(token) ? "该日期已存在" : null;
			},
			onAdd: (value) => {
				const rule = find();
				if (rule) this.session.tx.rules.updateOne(ruleId, { [field]: [...rule[field], value.trim()] });
			},
			onRemove: (index) => {
				const rule = find();
				if (rule) this.session.tx.rules.updateOne(ruleId, { [field]: rule[field].filter((_, i) => i !== index) });
			},
			onDone: () => this.pop(),
		});
	}

	/** 改规则有效期（留空清除） */
	private editRuleValidUntil(ruleId: string): void {
		const rule = this.session.schema.rules.find((r) => r._id === ruleId);
		if (!rule) return;
		this.promptText({
			title: "编辑有效期",
			note: "YYYY-MM-DD；留空清除（过期后该规则不参与匹配）",
			initialValue: rule.validUntil ?? "",
			validate: (value) => {
				const token = value.trim();
				if (token === "") return null;
				return /^\d{4}-\d{2}-\d{2}$/.test(token) && isValidDateToken(token) ? null : "应为 YYYY-MM-DD";
			},
			onSubmit: (value) => {
				const token = value.trim();
				this.session.tx.rules.updateOne(ruleId, { validUntil: token === "" ? undefined : token });
				this.lastMessage = token === "" ? "已清除有效期" : `有效期至 ${token}`;
			},
		});
	}

	/** 删除规则（引用保护） */
	private deleteRule(ruleId: string): void {
		const rule = this.session.schema.rules.find((r) => r._id === ruleId);
		if (!rule) return;
		this.push(
			this.buildConfirmPage(`删除规则「${rule.name}」？`, () => {
				const check = checkRuleDeletable(this.session.schema, ruleId);
				if (!check.ok) {
					this.lastMessage = check.reason;
					this.pop();
					return;
				}
				this.session.tx.rules.deleteOne(ruleId);
				this.pop();
				this.pop();
				this.lastMessage = `已删除规则「${rule.name}」`;
			}),
		);
	}

	// ── 方案表 ────────────────────────────────────────────

	/** 方案表页：列表（含反向引用）+ 新建 */
	private buildPlanPage(): Page {
		return new ActionMenu(
			this.theme,
			"方案",
			() => [
				...this.session.schema.plans.map((plan) => ({
					id: `plan:${plan._id}`,
					cells: () => [
						{
							align: true,
							spans: () => [
								{ text: () => `${plan.enabled ? "◉" : "◌"} ${plan.name}` },
								...(plan.alias ? [{ text: () => `@${plan.alias}`, color: "dim" }] : []),
							],
						},
						{
							align: true,
							spans: () => [
								{ text: () => `${plan.ruleIds.length} 条规则` },
								{ text: () => `｜${this.planModelsLabel(plan._id)}`, color: "dim" },
							],
						},
						{
							spans: () => [
								{ text: () => (plan.enabled ? "[启用]" : "[已禁用]"), color: plan.enabled ? "success" : "warning" },
							],
						},
					],
					run: () => this.push(this.buildPlanDetailPage(plan._id)),
				})),
				{
					id: "plan:new",
					label: () => "＋新建方案",
					detail: () => "规则组；模型只对接方案",
					run: () => this.createPlan(),
				},
			],
			() => this.pop(),
		);
	}

	/** 引用某方案的模型列表 */
	private planModels(planId: string): string[] {
		return this.session.schema.models
			.filter((m) => m.planId === planId)
			.map((m) => `${m.provider}/${m.model}`);
	}

	/** 反向引用的展示文案 */
	private planModelsLabel(planId: string): string {
		const models = this.planModels(planId);
		return models.length === 0 ? "未被模型引用" : `被 ${models.join("、")} 引用`;
	}

	/** 新建方案（名称唯一，规则后加） */
	private createPlan(): void {
		this.promptText({
			title: "新建方案",
			note: "名称全表唯一；别名可在详情页设置",
			placeholder: "如：2026.8 价格方案",
			validate: (value) => this.validateNewName("plans", value),
			onSubmit: (name) => {
				this.session.tx.plans.insertOne({ name: name.trim(), enabled: true, ruleIds: [] });
				this.lastMessage = `已新建方案「${name.trim()}」`;
			},
		});
	}

	/** 方案详情：别名 / 启停 / 规则 / 反向引用 / 改名 / 删除 */
	private buildPlanDetailPage(planId: string): Page {
		const find = () => this.session.schema.plans.find((p) => p._id === planId);
		return new ActionMenu(
			this.theme,
			() => find()?.name ?? "方案",
			() => [
				{
					id: "plan:alias",
					label: () => `别名：${find()?.alias ?? "无"}`,
					detail: () => "用于 HUD 显示，尽可能短；留空清除",
					run: () => this.editPlanAlias(planId),
				},
				{
					id: "plan:toggle",
					label: () => (find()?.enabled ? "禁用该方案" : "启用该方案"),
					detail: () => `当前：${find()?.enabled ? "启用" : "已禁用"}`,
					run: () => {
						const plan = find();
						if (plan) this.session.tx.plans.updateOne(planId, { enabled: !plan.enabled });
					},
				},
				{
					id: "plan:rules",
					label: () => `规则（${find()?.ruleIds.length ?? 0} 条）`,
					detail: () => "Enter 增删规则",
					run: () => this.push(this.buildPlanRulesPage(planId)),
				},
				{
					id: "plan:models",
					label: () => `引用此方案的模型：${this.planModels(planId).length} 个`,
					detail: () => this.planModelsLabel(planId),
					run: () => this.push(this.buildPlanModelsPage(planId)),
				},
				{ id: "plan:rename", label: () => "重命名该方案", run: () => this.renameDoc("plans", planId) },
				{
					id: "plan:delete",
					label: () => "删除该方案",
					detail: () => "被模型绑定时会被拒绝",
					run: () => this.deletePlan(planId),
				},
			],
			() => this.pop(),
		);
	}

	/** 改方案别名（用于 HUD；留空清除） */
	private editPlanAlias(planId: string): void {
		const plan = this.session.schema.plans.find((p) => p._id === planId);
		if (!plan) return;
		this.promptText({
			title: "编辑别名",
			note: "用于 HUD/footer 短名，尽可能短；留空清除",
			initialValue: plan.alias ?? "",
			onSubmit: (value) => {
				const alias = value.trim();
				this.session.tx.plans.updateOne(planId, { alias: alias === "" ? undefined : alias });
				this.lastMessage = alias === "" ? "已清除别名" : `别名已设为「${alias}」`;
			},
		});
	}

	/** 方案内规则增删页 */
	private buildPlanRulesPage(planId: string): Page {
		const find = () => this.session.schema.plans.find((p) => p._id === planId);
		return new ActionMenu(
			this.theme,
			() => "规则",
			() => {
				const plan = find();
				const entries = (plan?.ruleIds ?? []).map((ruleId) => {
					const rule = this.session.schema.rules.find((r) => r._id === ruleId);
					return {
						id: `rule:${ruleId}`,
						label: () => rule?.name ?? "（规则缺失）",
						detail: () => (rule ? `${this.rateNameOf(rule.rateId)}｜${this.ruleScheduleLabel(ruleId)}` : ""),
						run: () => {
							const current = find();
							if (!current) return;
							this.session.tx.plans.updateOne(planId, { ruleIds: current.ruleIds.filter((id) => id !== ruleId) });
							this.lastMessage = `已移出规则「${rule?.name ?? ruleId}」`;
						},
					};
				});
				entries.push({
					id: "plan:add-rule",
					label: () => "＋添加规则",
					detail: () => "从规则表选择",
					run: () => this.push(this.buildAddRuleToPlanPage(planId)),
				});
				return entries;
			},
			() => this.pop(),
			"↑↓ 移动 · Enter 移出 / 添加 · Esc 返回",
		);
	}

	/** 从未纳入的规则中选一条加入方案 */
	private buildAddRuleToPlanPage(planId: string): Page {
		const find = () => this.session.schema.plans.find((p) => p._id === planId);
		return new ActionMenu(
			this.theme,
			"添加规则",
			() => {
				const plan = find();
				const available = this.session.schema.rules.filter((r) => !plan?.ruleIds.includes(r._id));
				if (available.length === 0) {
					return [{ id: "rule:none", label: () => "（没有可添加的规则）", run: () => this.pop() }];
				}
				return available.map((rule) => ({
					id: `rule:${rule._id}`,
					label: () => rule.name,
					detail: () => `${this.rateNameOf(rule.rateId)}｜${this.ruleScheduleLabel(rule._id)}`,
					run: () => {
						const current = find();
						if (!current) return;
						this.session.tx.plans.updateOne(planId, { ruleIds: [...current.ruleIds, rule._id] });
						this.pop();
						this.lastMessage = `已加入规则「${rule.name}」`;
					},
				}));
			},
			() => this.pop(),
		);
	}

	/** 引用此方案的模型：列出已绑定 + 添加模型（检索） */
	private buildPlanModelsPage(planId: string): Page {
		return new ActionMenu(
			this.theme,
			"引用此方案的模型",
			() => {
				const bound: MenuEntry[] = this.planModels(planId).map((label) => ({
					id: `bound:${label}`,
					label: () => label,
					detail: () => "已绑定（如需改绑请到该模型）",
					run: () => {
						this.lastMessage = `${label} 已绑定本方案`;
					},
				}));
				bound.push({
					id: "plan:add-model",
					label: () => "＋添加模型",
					detail: () => "检索模型并绑定到本方案（已绑其它方案的会被拒绝）",
					run: () => this.promptModelSearch((ref) => this.addModelToPlan(planId, ref)),
				});
				return bound;
			},
			() => this.pop(),
		);
	}

	/** 把模型绑定到方案（已绑其它方案 → 拒绝；已绑本方案 → 提示） */
	private addModelToPlan(planId: string, ref: ModelRef): void {
		const plan = this.session.schema.plans.find((p) => p._id === planId);
		if (!plan) return;
		const existing = this.session.schema.models.find((m) => m.provider === ref.provider && m.model === ref.id);
		if (existing && existing.planId === planId) {
			this.lastMessage = `${ref.provider}/${ref.id} 已绑定本方案`;
		} else if (existing) {
			const other = this.session.schema.plans.find((p) => p._id === existing.planId);
			this.lastMessage = `${ref.provider}/${ref.id} 已绑定方案「${other?.name ?? "未知"}」，请先到该模型改绑`;
		} else {
			this.session.tx.models.insertOne({ provider: ref.provider, model: ref.id, planId });
			this.lastMessage = `已把 ${ref.provider}/${ref.id} 绑定到「${plan.name}」`;
		}
		this.pop(); // 回模型搜索上一层
	}

	/** 删除方案（引用保护） */
	private deletePlan(planId: string): void {
		const plan = this.session.schema.plans.find((p) => p._id === planId);
		if (!plan) return;
		this.push(
			this.buildConfirmPage(`删除方案「${plan.name}」？`, () => {
				const check = checkPlanDeletable(this.session.schema, planId);
				if (!check.ok) {
					this.lastMessage = check.reason;
					this.pop();
					return;
				}
				this.session.tx.plans.deleteOne(planId);
				this.pop();
				this.pop();
				this.lastMessage = `已删除方案「${plan.name}」`;
			}),
		);
	}
}

/**
 * 打开计费配置抽屉（TUI 专用）。
 * 非 TUI 模式返回 false，调用方据此回退文本输出。
 */
export async function openPricingDrawer(
	ctx: ExtensionCommandContext,
	options: DrawerOptions = {},
): Promise<boolean> {
	if (ctx.mode !== "tui") return false;
	const session = new PricingSession(options.filePath);
	// 从 pi 模型注册表取全部可用模型，供“添加模型计费”检索（缺省为空）
	const registryModels = ctx.modelRegistry?.getAll?.() as unknown as Array<{ provider: string; id: string }> | undefined;
	const availableModels =
		options.availableModels ?? registryModels?.map((m) => ({ provider: String(m.provider), id: m.id })) ?? [];
	await ctx.ui.custom<boolean>((_tui, theme, _keybindings, done) =>
		new PricingDrawer(session, theme as unknown as UiTheme, done, { ...options, availableModels }),
	);
	return true;
}
