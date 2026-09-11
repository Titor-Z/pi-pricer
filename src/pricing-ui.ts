/**
 * 表现层：三级钻取抽屉（厂商 → 模型 → 详情）+ 编辑会话。
 *
 * 交互契约（对应 DESIGN.md Editor）：
 * - 编辑先写内存（PricingDraft），Ctrl+S 全量落盘，Ctrl+R 丢弃未保存改动
 * - 下钻沿用 SettingsList 原生 submenu（Enter 进入子级，Esc 逐级返回），搜索可过滤
 * - 绑定优先级排序不走 TUI（SettingsList 不暴露选中索引）；重排入口规划中（v0.11 跟进）
 * - 无 TUI（headless）时 open() 返回 false，由接线层回退成 /price list 文本
 */

import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	matchesKey,
	SettingsList,
	Text,
	type Component,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { listProviderRows, listProviderPlans } from "./pricing-builder.ts";
import { renderHelpMarkdown, renderModelDetailMarkdown, renderPriceListMarkdown, renderResolveResultMarkdown, renderSchemaMarkdown } from "./pricing-format.ts";
import { InfoPage, type DrawerTheme } from "./pricing-info-page.ts";
import { PromptOverlay } from "./pricing-prompt.ts";
import { PricingDraft } from "./pricing-draft.ts";
import { describeSchedule, isValidCalendarDate, parsePriceInput, price } from "./pricing-desc.ts";
import { RuleFormPage, PriceFormPage, buildDatesEditor } from "./pricing-form.ts";

// 日期校验原生于展示层，后上移到 pricing-desc 共享；此处再导出保持外部引用兼容
export { isValidCalendarDate } from "./pricing-desc.ts";

/** 抽屉标题的层级格式 */
function levelTitle(crumb: string): string {
	return `模型计费配置 · ${crumb}`;
}

/** 可传入的 TUI 子集（只用到 showOverlay 弹输入层） */
interface DrawerTui {
	showOverlay?: (component: Component, options?: unknown) => { hide?: () => void };
}

/**
 * 动作菜单：SettingsList 的普通项（无 submenu / 无 values）按 Enter 不会触发 onChange，
 * 因此"执行动作"类页面用这个轻量自绘菜单，行为可预期。
 */
class ActionMenu implements Component {
	private selected = 0;

	constructor(
		private readonly title: string,
		private readonly actions: Array<{ label: string; detail?: string; run: () => void }>,
		private readonly theme: DrawerTheme,
		private readonly onCancel: () => void,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [`  ${this.theme.bold(this.title)}`, ""];
		this.actions.forEach((a, i) => {
			const cursor = i === this.selected ? "→ " : "  ";
			lines.push(`${cursor}${a.label}${a.detail ? `   ${a.detail}` : ""}`.slice(0, width));
		});
		lines.push("");
		lines.push(this.theme.fg("dim", "  ↑↓ 选择 · Enter 执行 · Esc 返回"));
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + this.actions.length) % this.actions.length;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.actions.length;
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.actions[this.selected]?.run();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		}
	}
}

/**
 * 给 SettingsList 根页追加上下文注脚（渲染在列表下方、状态栏上方）。
 * 为什么包一层 Component 而不是直接改 SettingsList：Container 不转发 handleInput，
 * 直接包裹会让键盘失效；这里透传 render / handleInput / invalidate 即可。
 */
function withRootNotes(inner: Component, notes: string[], theme: DrawerTheme): Component {
	if (notes.length === 0) return inner;
	return {
		render(width: number): string[] {
			return [...inner.render(width), ...notes.map((n) => theme.fg("dim", `  注：${n}`))];
		},
		handleInput(data: string): void {
			inner.handleInput?.(data);
		},
		invalidate(): void {
			inner.invalidate?.();
		},
	};
}

/** 校验解析时间输入："YYYY-MM-DDTHH:mm"（也接受 "YYYY-MM-DD"，按当天 12:00） */
function parseDateTimeInput(raw: string): Date | null {
	const text = raw.trim();
	if (text === "") return null;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00` : text;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) return null;
	const date = new Date(`${normalized}:00`);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** 抽屉第 0 级的标题（返回厂商列表时恢复） */
const ROOT_TITLE = "模型计费配置 · 厂商";

/**
 * 抽屉初始页：默认只显示模型（根层职责单一），管理面由子命令直达。
 * 命名与 CLI 子命令一致（scheme / rate / calendar），见 AGENTS.md v0.7 决策；
 * help / schema / list / model / resolve 为只读说明页（InfoPage，不建注册表列表）。
 */
export type DrawerPage = "models" | "scheme" | "rate" | "calendar" | "help" | "schema" | "list" | "model" | "resolve";

/** 参数化只读页的入参（model / resolve 直达页用） */
export interface InfoPageOptions {
	provider?: string;
	model?: string;
	/** resolve 调试的指定时间（undefined = 此刻） */
	ts?: Date;
}

/** 各初始页的根标题（Esc 回到此层时恢复） */
const PAGE_TITLES: Record<DrawerPage, string> = {
	models: ROOT_TITLE,
	scheme: "模型计费配置 · 方案",
	rate: "模型计费配置 · 价格",
	calendar: "模型计费配置 · 日历",
	help: "模型计费配置 · 帮助",
	schema: "模型计费配置 · Schema",
	list: "模型计费配置 · 总览",
	model: "模型计费配置 · 模型详情",
	resolve: "模型计费配置 · 解析调试",
};

/** 只读说明页的初始页集合（走 buildInfoRoot，不做注册表列表） */
const INFO_PAGES = new Set<DrawerPage>(["help", "schema", "list", "model", "resolve"]);

/**
 * 三级钻取抽屉：独立于命令层，filePath 注入便于测试；不访问 pi ExtensionAPI。
 */
export class PricingDrawer {
	/** 当前场景的 overlay 句柄槽（buildScene 装配，askText 读写） */
	private overlaySlot?: { current: { hide: () => void; dispose?: () => void } | null };

	constructor(private readonly filePath?: string) {}

	/**
	 * 打开抽屉；无 custom UI 时返回 false，交给命令层回退文本输出。
	 * page 指定初始页（默认 models = 厂商列表）；管理面子命令可直接跳到对应注册表。
	 */
	async open(context: unknown, page: DrawerPage = "models", opts: InfoPageOptions = {}): Promise<boolean> {
		const ui = (context as { ui?: { custom?: unknown } })?.ui;
		if (typeof ui?.custom !== "function") return false;
		await (ui.custom as (factory: unknown) => Promise<unknown>)((tui: unknown, theme: DrawerTheme, _kb: unknown, done: (result?: undefined) => void) => {
			return this.buildScene(tui as DrawerTui, theme, () => done(undefined), page, opts);
		});
		return true;
	}

	/**
	 * 组装抽屉场景（边框 + 动态标题 + 状态栏 + 第 0 级厂商列表）。
	 * Ctrl+S / Ctrl+R 在顶层拦截，保证任意层级都能保存/重置。
	 */
	private buildScene(tui: DrawerTui, theme: DrawerTheme, close: () => void, initialPage: DrawerPage = "models", options: InfoPageOptions = {}): Component {
		// 场景级 overlay 句柄槽：askText 由各 builders 调用，需要访问同一份打开状态
		const overlaySlot: { current: { hide: () => void; dispose?: () => void } | null } = { current: null };
		this.overlaySlot = overlaySlot;
		const draft = new PricingDraft(this.filePath);
		const container = new Container();
		const rootTitleOfPage = PAGE_TITLES[initialPage];
		const title = new Text(theme.fg("accent", theme.bold(rootTitleOfPage)), 1, 1);

		/**
		 * 当前钻取深度：根层为 0，每进一级 +1。
		 * 为什么不用标题反推：标题是展示层状态，用它决定 Esc 归属会把展示与逻辑耦合，
		 * 一旦某子页标题与根标题相同就会误判。深度计数是唯一的逻辑真相。
		 */
		// 直达管理页时已是"一层"（Esc 一次即退出，不弹回无关的模型列表）
		let depth = initialPage === "models" ? 0 : 1;

		/** 换标题并强制重绘（纯展示，不承担状态推断） */
		const setTitle = (text: string): void => {
			title.setText(theme.fg("accent", theme.bold(text)));
			container.invalidate();
		};

		/** 进入子级：深度 +1 */
		const enterLevel = (): void => {
			depth += 1;
		};

		/** 返回上级：深度 -1（不低于 0） */
		const leaveLevel = (): void => {
			depth = Math.max(0, depth - 1);
		};

		/** 状态栏最近一次提示文案（与 refreshStatus 的参数区分，避免同名遮蔽） */
		let lastMessage = "";
		const statusText = new Text("", 1, 0);
		const refreshStatus = (message = ""): void => {
			lastMessage = message;
			const dirty = draft.isDirty;
			const left = dirty ? theme.fg("warning", `● 未保存改动（${draft.changedAreas.join("、")}）`) : theme.fg("success", "✓ 已保存");
			const detail = lastMessage ? `   ${lastMessage}` : "";
			const keys = theme.fg("dim", "  Ctrl+S 保存 · Ctrl+R 重置 · Esc 返回");
			statusText.setText(`${left}${detail}${keys}`);
			container.invalidate();
		};

		/**
		 * Esc 已提示过"放弃退出"？有未保存改动时第一次 Esc 只提示，第二次才真正退出。
		 * 没有这个状态位会导致提示后仍然退不出（isDirty 恒真，每次 Esc 都走提示分支）。
		 */
		let escHintShown = false;

		/** 保存：校验失败只提示，不退出编辑器 */
		const save = (): void => {
			const result = draft.save();
			escHintShown = false;
			refreshStatus(
				result.ok
					? "保存成功：已写入 ~/.pi/model-pricing.json"
					: theme.fg("error", `保存失败：${result.reason}`),
			);
			if (result.ok) rebuildRoot();
		};

		/** 重置：丢弃未保存改动 */
		const reset = (): void => {
			draft.reset();
			escHintShown = false;
			rebuildRoot();
			refreshStatus("已丢弃未保存改动");
		};

		let root: Component | null = null;

		/**
		 * 是否有输入覆盖层打开（同一时刻最多一个）。
		 * 为什么需要这个标记：ExtensionInputComponent 的 Esc 走 onCancel，
		 * 若 onCancel 里不关闭覆盖层，它会永久残留在屏幕上（"卡屏"）；
		 * 同时底层组件也不应在覆盖层打开时响应按键。
		 */
		const hasOverlay = (): boolean => overlaySlot.current !== null;

		/** 关闭当前输入覆盖层（幂等；submit 与 cancel 两条路径都必须调用） */
		const closeOverlay = (): void => {
			this.closeOverlay();
		};

		/**
		 * 临时页栈：在 ActionMenu 之上再叠一层只读页（如解析结果）。
		 * 顶层 handleInput 优先派发给栈顶；Esc 由栈顶的 handleInput 触发 popPage 出栈。
		 * 与 overlay 的分工：pageStack = 只读页（读），overlay = 输入层（写），二者互斥。
		 */
		const pageStack: Component[] = [];
		const popPage = (): void => {
			const top = pageStack.pop();
			if (!top) return;
			container.removeChild(top);
			container.invalidate();
		};
		const pushPage = (component: Component): void => {
			pageStack.push(component);
			container.addChild(component);
			container.invalidate();
		};

		/**
		 * 重建根页（保存/重置后价格列需要刷新）。
		 * 按初始页分派：INFO_PAGES = 只读 InfoPage；其余 = 注册表列表（子命令直达用）。
		 */
		const rebuildRoot = (): void => {
			if (root) container.removeChild(root);
			if (INFO_PAGES.has(initialPage)) {
				root = this.buildInfoRoot(initialPage, theme, close, refreshStatus, options);
			} else {
				root = this.buildRootList(initialPage, draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, pushPage, popPage, () => container, close);
			}
			container.addChild(root);
			container.invalidate();
		};



		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		container.addChild(title);
		rebuildRoot();
		container.addChild(statusText);
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		refreshStatus();

		const kb = getKeybindings();
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				// Ctrl+S / Ctrl+R：任意层级可用，优先于列表导航。
				// 为什么用 matchesKey 而不是裸字节比较：pi-tui 会启用增强键盘协议
				// （Kitty / modifyOtherKeys），支持该协议的终端把 Ctrl+S 编码为
				// CSI-u 序列（\x1b[115;5u）或 modifyOtherKeys（\x1b[27;5;115~），
				// 裸字节 \x13 永远不命中 → 保存静默失效。matchesKey 归一化三种编码。
				if (matchesKey(data, "ctrl+s")) {
					save();
					return;
				}
				if (matchesKey(data, "ctrl+r")) {
					reset();
					return;
				}
				// 根层 Esc + 有未保存改动：第一次提示，第二次（escHintShown）丢弃并退出
				if (kb.matches(data, "tui.select.cancel") && draft.isDirty && depth === 0) {
					if (!escHintShown) {
						escHintShown = true;
						refreshStatus(theme.fg("warning", "有未保存改动：Ctrl+S 保存 / Ctrl+R 重置 / 再按 Esc 放弃退出"));
						return;
					}
					close();
					return;
				}
				// 输入覆盖层打开时：底层（pageStack / root）一律不响应，避免同一按键双重处理
				if (hasOverlay()) return;
				// 临时页栈优先；栈顶的只读页在 Esc 时会调用 popPage
				const top = pageStack[pageStack.length - 1];
				if (top) {
					top.handleInput?.(data);
					return;
				}
				root?.handleInput?.(data);
			},
		};
	}

	/**
	 * 根列表分派：models = 厂商列表；scheme/rate/calendar = 直达对应注册表。
	 * 管理面不再挂在模型列表尾部（根层职责单一），改由子命令直达，
	 * 因此这里需要按初始页构造不同根列表。
	 */
	private buildRootList(
		page: DrawerPage,
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		pushPage: (component: Component) => void,
		popPage: () => void,
		getContainerRef: () => Component,
		goBack: () => void,
	): Component {
		void pushPage;
		void popPage;
		switch (page) {
			case "scheme":
				return withRootNotes(
					this.buildPlanRegistry(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, getContainerRef, goBack),
					["命名沿革 —— 原 /price plan 已改名 /price scheme。"],
					theme,
				);
			case "rate":
				return withRootNotes(
					this.buildPriceRegistry(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, getContainerRef, goBack),
					["命名沿革 —— 原 /price price 已改名 /price rate。"],
					theme,
				);
			case "calendar":
				return withRootNotes(
					this.buildCalendarRegistry(draft, tui, theme, refreshStatus, enterLevel, leaveLevel, getContainerRef, goBack),
					["日期格式 —— MM-DD 每年循环；YYYY-MM-DD 精确一次。"],
					theme,
				);
			default:
				return withRootNotes(
					this.buildProviderList(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, pushPage, popPage, goBack),
					["绑定数组顺序即优先级，首个命中生效；绑定重排入口暂未提供（规划中）。"],
					theme,
				);
		}
	}

	/**
	 * 只读说明根页：/price help / /price schema / list / model / resolve 直达的 InfoPage。
	 * Esc 直接关闭抽屉（depth=1，等效于其他子命令直达页）。
	 */
	private buildInfoRoot(page: DrawerPage, theme: DrawerTheme, close: () => void, refreshStatus: (msg?: string) => void, options: InfoPageOptions = {}): Component {
		const markdown = this.infoMarkdown(page, options);
		return new InfoPage(markdown, theme, () => {
			refreshStatus();
			close();
		});
	}

	/** 只读说明页的 Markdown 内容（按初始页分派；model/resolve 用 options 参数化） */
	private infoMarkdown(page: DrawerPage, options: InfoPageOptions): string {
		const file = this.filePath;
		switch (page) {
			case "help":
				return renderHelpMarkdown();
			case "schema":
				return renderSchemaMarkdown();
			case "list":
				return renderPriceListMarkdown(file);
			case "model":
				return renderModelDetailMarkdown(options.provider ?? "", options.model ?? "", file);
			case "resolve": {
				const ts = options.ts;
				return renderResolveResultMarkdown(options.model ?? "", options.provider ?? "", ts, file);
			}
			default:
				// models / scheme / rate / calendar 不在此列，不应到达
				return renderHelpMarkdown();
		}
	}

	/** 第 0 级：厂商列表（Enter 下钻到该厂商的模型列表） */
	private buildProviderList(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		pushPage: (component: Component) => void,
		popPage: () => void,
		close: () => void,
	): SettingsList {
		const rows = listProviderRows(this.filePath);
		const items: SettingItem[] = rows.map((row) => ({
			id: row.providerId,
			label: `${row.providerId}  (${row.modelCount}模型 · ${row.planDesc})`,
			currentValue: "",
			description: row.description,
			submenu: (_currentValue, done) => {
				enterLevel();
				setTitle(levelTitle(row.providerId));
				return this.buildModelList(draft, tui, theme, row.providerId, setTitle, refreshStatus, enterLevel, leaveLevel, pushPage, popPage, () => {
					setTitle(ROOT_TITLE);
					leaveLevel();
					done(undefined);
				});
			},
		}));

		// 管理面（方案/价格/日历）不再挂在这里：根层职责单一，仅展示模型；
		// 管理面由子命令直达（/price scheme | rate | calendar）。

		return new SettingsList(
			items,
			Math.min(items.length + 4, 12),
			getSettingsListTheme(),
			() => {},
			close,
			{ enableSearch: true },
		);
	}

	/** 第 1 级：模型列表（Enter 下钻到该模型的详情页；Esc 返回厂商列表） */
	private buildModelList(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		providerId: string,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		pushPage: (component: Component) => void,
		popPage: () => void,
		goBack: () => void,
	): SettingsList {
		const schema = draft.snapshot();
		const modelIds = Object.keys(schema.providers[providerId]?.models ?? {});
		const items: SettingItem[] = modelIds.map((modelId) => {
			const conf = schema.providers[providerId].models[modelId];
			const enabledCount = conf.plans.filter((b) => b.enabled).length;
			return {
				id: modelId,
				label: `${modelId}  ${enabledCount}/${conf.plans.length} 档启用${conf.alias ? ` · aka ${conf.alias}` : ""}`,
				currentValue: "",
				description: `${providerId}/${modelId}：绑定 ${conf.plans.length} 个方案，启用 ${enabledCount} 个`,
				submenu: (_currentValue, done) => {
					enterLevel();
					setTitle(levelTitle(`${providerId}/${modelId}`));
					return this.buildModelDetail(draft, tui, theme, providerId, modelId, setTitle, refreshStatus, enterLevel, leaveLevel, () => {
						setTitle(levelTitle(providerId));
						leaveLevel();
						done(undefined);
					}, pushPage, popPage);
				},
			};
		});
		return new SettingsList(
			items,
			Math.min(items.length + 4, 12),
			getSettingsListTheme(),
			() => {},
			goBack,
			{ enableSearch: true },
		);
	}

	/** 第 2 级：模型详情（可编辑菜单：绑定启停/解绑/增绑、别名、查看详情） */
	private buildModelDetail(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		providerId: string,
		modelId: string,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		goBack: () => void,
		pushPage: (component: Component) => void,
		popPage: () => void,
	): SettingsList {
		const schema = draft.snapshot();
		const conf = schema.providers[providerId]?.models[modelId];
		const items: SettingItem[] = [];

		if (!conf) {
			items.push({ id: "__missing", label: "模型不存在", currentValue: "", description: `${providerId}/${modelId} 未在配置中` });
			return new SettingsList(items, 6, getSettingsListTheme(), () => {}, goBack);
		}

		// 每条绑定：Enter 进入该项的操作子菜单；#N = 优先级序号（数组顺序即优先级）
		conf.plans.forEach((binding, order) => {
			const plan = schema.plans[binding.plan];
			const firstHint = order === 0 ? " ← 先匹配" : "";
			items.push({
				id: `bind:${binding.plan}`,
				label: `#${order + 1} ${binding.enabled ? "◉" : "◌"} ${plan?.name ?? binding.plan}`,
				currentValue: binding.enabled ? "已启用" : "已禁用",
				description: plan
					? `优先级 #${order + 1}${firstHint}｜${binding.plan}：${plan.rules.map((r) => describeSchedule(r.schedule)).join(" ; ")}｜绑定重排入口规划中`
					: `${binding.plan}（方案不存在）`,
				submenu: (_v, done) => {
					enterLevel();
					return this.buildBindingActions(draft, theme, providerId, modelId, binding.plan, refreshStatus, () => {
						setTitle(levelTitle(`${providerId}/${modelId}`));
						leaveLevel();
						done(undefined);
					});
				},
			});
		});

		// 追加绑定
		const unbound = listProviderPlans().filter((p) => !conf.plans.some((b) => b.plan === p.id));
		if (unbound.length > 0) {
			items.push({
				id: "__add",
				label: "＋ 绑定新方案",
				currentValue: `${unbound.length} 可选`,
				description: "选择后追加到末尾（最低优先级）；绑定重排入口规划中",
				submenu: (_v, done) => {
					enterLevel();
					const inner = done;
					return this.buildAddBinding(draft, theme, providerId, modelId, unbound, refreshStatus, () => {
						leaveLevel();
						inner(undefined);
					});
				},
			});
		}

		// 别名编辑
		items.push({
			id: "__alias",
			label: "别名（台账匹配）",
			currentValue: conf.alias ?? "（未设置）",
			description: "pi 内部 model 名的别名，用于 pi-prompt / pi-usage 台账匹配",
			submenu: (_v, done) => {
				enterLevel();
				return this.buildAliasInput(tui, theme, draft, providerId, modelId, refreshStatus, () => {
					leaveLevel();
					done(undefined);
				});
			},
		});

		// 解析调试（可选时刻：预演某个时间点会命中哪档价）
		items.push({
			id: "__resolve",
			label: "解析调试（预演某时刻命中链）",
			currentValue: "",
			description: "展示 first-match 过程；可指定时间预演（如明天 10 点走哪档）",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				/** 用给定时刻打开只读命中链页（undefined = 当前时刻） */
				const showChain = (at?: Date): void => {
					const markdown = renderResolveResultMarkdown(modelId, providerId, at, this.filePath);
					setTitle(levelTitle(`${providerId}/${modelId}/resolve`));
					pushPage(new InfoPage(markdown, theme, () => {
						popPage();
						setTitle(levelTitle(`${providerId}/${modelId}`));
					}));
				};
				return new ActionMenu(
					`解析调试 ${providerId}/${modelId}`,
					[
						{ label: "此刻", detail: "用当前时间解析", run: () => showChain(undefined) },
						{
							label: "指定时间…",
							detail: "YYYY-MM-DDTHH:mm",
							run: () => this.askText(tui, theme, {
								title: "解析时间（YYYY-MM-DDTHH:mm）",
								placeholder: "2026-09-16T10:00",
								notes: ["留空 = 以当前时刻解析；只给日期（如 2026-09-16）按当天 12:00"],
								validate: (value) => {
									const raw = value.trim();
									if (raw === "") return null;
									return parseDateTimeInput(raw) ? null : `无效时间：${raw}（需 YYYY-MM-DDTHH:mm）`;
								},
								onSubmit: (value) => {
									const parsed = parseDateTimeInput(value.trim());
									showChain(parsed ?? undefined);
								},
								onCancel: () => refreshStatus("已取消输入"),
							}),
						},
					],
					theme,
					() => { setTitle(levelTitle(`${providerId}/${modelId}`)); finish(); },
				);
			},
		});

		// 只读详情（保留原有纯文本视图）
		items.push({
			id: "__detail",
			label: "查看只读详情",
			currentValue: "",
			description: "含基准/覆盖档与实时生效价",
			submenu: (_v, done) => {
				enterLevel();
				const markdown = renderModelDetailMarkdown(providerId, modelId, this.filePath);
				return new InfoPage(markdown, theme, () => {
					setTitle(levelTitle(`${providerId}/${modelId}`));
					leaveLevel();
					done(undefined);
				}, ["绑定数组顺序即优先级，首个命中生效；绑定重排入口暂未提供（规划中）。"]);
			},
		});

		return new SettingsList(items, Math.min(items.length + 4, 14), getSettingsListTheme(), () => {}, goBack);
	}

	/** 第 3 级：单条绑定的操作（切换启用 / 解绑） */
	private buildBindingActions(
		draft: PricingDraft,
		theme: DrawerTheme,
		providerId: string,
		modelId: string,
		planId: string,
		refreshStatus: (msg?: string) => void,
		goBack: () => void,
	): Component {
		const binding = draft.snapshot().providers[providerId]?.models[modelId]?.plans.find((b) => b.plan === planId);
		const enabled = binding?.enabled ?? false;
		return new ActionMenu(
			`绑定 ${planId}`,
			[
				{
					label: enabled ? "禁用该绑定" : "启用该绑定",
					detail: enabled ? "当前启用" : "当前禁用",
					run: () => {
						draft.toggleBinding(providerId, modelId, planId);
						refreshStatus(`已${enabled ? "禁用" : "启用"} ${planId}（Ctrl+S 保存）`);
						goBack();
					},
				},
				{
					label: "解除绑定",
					detail: "从该模型的绑定列表移除",
					run: () => {
						draft.removeBinding(providerId, modelId, planId);
						refreshStatus(`已解绑 ${planId}（Ctrl+S 保存）`);
						goBack();
					},
				},
			],
			theme,
			goBack,
		);
	}

	/** 第 3 级（变体）：从可选方案中挑一个追加绑定 */
	private buildAddBinding(
		draft: PricingDraft,
		theme: DrawerTheme,
		providerId: string,
		modelId: string,
		candidates: Array<{ id: string; name: string }>,
		refreshStatus: (msg?: string) => void,
		done: (selectedValue?: string) => void,
	): Component {
		return new ActionMenu(
			"选择要绑定的方案（追加到末尾 = 最低优先级）",
			candidates.map((c) => ({
				label: c.name,
				detail: c.id,
				run: () => {
					draft.addBinding(providerId, modelId, c.id);
					refreshStatus(`已追加绑定 ${c.id}（Ctrl+S 保存）`);
					done(undefined);
				},
			})),
			theme,
			() => done(undefined),
		);
	}

	/** 别名输入：走 PromptOverlay 覆盖层（统一 anchor/帮助脚注） */
	private buildAliasInput(
		tui: DrawerTui,
		theme: DrawerTheme,
		draft: PricingDraft,
		providerId: string,
		modelId: string,
		refreshStatus: (msg?: string) => void,
		done: (selectedValue?: string) => void,
	): Component {
		const current = draft.snapshot().providers[providerId]?.models[modelId]?.alias ?? "";
		this.askText(tui, theme, {
			title: "设置别名（留空清除）",
			initialValue: current,
			placeholder: current || "如 deepseek-v4-flash",
			notes: ["用作 pi-prompt / pi-usage 台账名的精确匹配；留空则清除别名"],
			onSubmit: (value) => {
				draft.setAlias(providerId, modelId, value);
				refreshStatus(`别名已改为 ${value || "（清除）"}（Ctrl+S 保存）`);
				done(undefined);
			},
			onCancel: () => done(undefined),
		});
		// 无 overlay 能力（测试/降级）时返回占位文本页兜底
		return this.buildTextPage("正在输入别名…", () => done(undefined));
	}

	/** 管理面：方案注册表（每条方案可编辑规则价格/有效期、复制、删除） */
	private buildPlanRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		getContainerRef: () => Component,
		goBack: () => void,
	): SettingsList {
		const schema = draft.snapshot();
		const items: SettingItem[] = Object.entries(schema.plans).map(([planId, plan]) => ({
			id: planId,
			label: `${plan.name}`,
			currentValue: `${plan.rules.length} 规则`,
			description: `${planId}：${plan.rules.map((r) => describeSchedule(r.schedule)).join(" ; ")}`,
			submenu: (_v, done) => {
				enterLevel();
				setTitle(levelTitle(`方案/${planId}`));
				return this.buildPlanActions(draft, tui, theme, planId, setTitle, refreshStatus, enterLevel, leaveLevel, getContainerRef, () => {
					setTitle(levelTitle("方案"));
					leaveLevel();
					done(undefined);
				});
			},
		}));

		items.unshift({
			id: "__newplan",
			label: "＋ 新建方案",
			currentValue: "",
			description: "新建空方案（默认挂首个价格实体的一条 always 规则）",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				this.askText(tui, theme, {
					title: "新方案 id（如 my-plan）",
					placeholder: "my-plan",
					notes: ["建议：小写字母、数字与连字符，如 vendor-workday；不能与已有方案重复"],
					validate: (raw) => {
						const id = raw.trim();
						if (id === "") return "方案 id 不能为空";
						if (draft.snapshot().plans[id]) return `方案已存在：${id}`;
						if (!Object.keys(draft.snapshot().prices)[0]) return "价格注册表为空，请先新建价格实体";
						return null;
					},
					onSubmit: (value) => {
						const id = value.trim();
						const firstPrice = Object.keys(draft.snapshot().prices)[0];
						draft.upsertPlan(id, {
							name: id,
							rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: firstPrice }],
						});
						refreshStatus(`已新建方案 ${id}（默认挂 ${firstPrice}；Ctrl+S 保存）`);
						finish();
					},
					onCancel: () => { refreshStatus("已取消新建方案"); finish(); },
				});
				return this.buildTextPage("正在输入新方案 id…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/** 管理面：单个方案的操作（改规则 / 追加 / 复制 / 删除） */
	private buildPlanActions(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		planId: string,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		getContainerRef: () => Component,
		goBack: () => void,
	): SettingsList {
		const plan = draft.snapshot().plans[planId];
		const items: SettingItem[] = [];

		if (!plan) {
			items.push({ id: "__missing", label: "方案不存在", currentValue: "", description: planId });
			return new SettingsList(items, 6, getSettingsListTheme(), () => {}, goBack);
		}

		plan.rules.forEach((rule, i) => {
			const p = draft.snapshot().prices[rule.price];
			items.push({
				id: `rule:${i}`,
				label: `规则 #${i}`,
				currentValue: p ? price(p.output) : rule.price,
				description: `${describeSchedule(rule.schedule)}${rule.validUntil ? ` · 有效期至 ${rule.validUntil}` : ""}`,
				submenu: (_v, done) => {
					enterLevel();
					setTitle(levelTitle(`方案/${planId}/规则#${i}`));
					const finishRuleEdit = (): void => {
						setTitle(levelTitle(`方案/${planId}`));
						leaveLevel();
						done(undefined);
					};
					return new RuleFormPage({
						draft,
						planId,
						ruleIndex: i,
						theme,
						askText: (req) => this.askText(tui, theme, {
							title: req.title,
							placeholder: req.placeholder,
							notes: req.notes,
							initialValue: req.initialValue,
							validate: req.validate,
							onSubmit: req.onSubmit,
							onCancel: () => refreshStatus("已取消输入"),
						}),
						onDone: finishRuleEdit,
						getContainerRef,
					});
				},
			});
		});

		items.push({
			id: "__ops",
			label: "方案操作（改名 / 追加规则 / 复制 / 删除）",
			currentValue: "",
			description: "重命名、追加规则、复制方案、删除方案",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				return new ActionMenu(
				`方案 ${planId} 操作`,
				[
					{
						label: "重命名方案",
						detail: "留空回退为 id",
						run: () => {
							this.askText(tui, theme, {
								title: `方案 ${planId} 的新名称`,
								initialValue: plan.name,
								placeholder: plan.name,
								notes: ["留空则回退为 id"],
								onSubmit: (value) => {
									draft.setPlanName(planId, value);
									refreshStatus(`方案 ${planId} 已改名（Ctrl+S 保存）`);
									finish();
								},
								onCancel: () => { refreshStatus("已取消改名"); },
							});
						},
					},
					{
						label: "＋ 追加规则",
						detail: "复制最后一条规则的形状",
						run: () => { draft.addRule(planId); refreshStatus("已追加规则（Ctrl+S 保存）"); finish(); },
					},
					{
						label: "复制方案",
						detail: "生成 <id>-copy",
						run: () => { const n = draft.duplicatePlan(planId); refreshStatus(n ? `已复制为 ${n}（Ctrl+S 保存）` : "复制失败"); finish(); },
					},
					{
						label: "删除方案",
						detail: "被模型绑定时会拒绝保存",
						run: () => { draft.deletePlan(planId); refreshStatus(`已删除方案 ${planId}（Ctrl+S 保存）`); finish(); },
					},
				],
				theme,
				finish,
			);
			},
		});

		return new SettingsList(items, Math.min(items.length + 4, 14), getSettingsListTheme(), () => {}, goBack);
	}


	/** 管理面：价格注册表（每条价格 → PriceFormPage 字段编辑页） */
	private buildPriceRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		getContainerRef: () => Component,
		goBack: () => void,
	): SettingsList {
		const items: SettingItem[] = Object.entries(draft.snapshot().prices).map(([priceId, entity]) => ({
			id: priceId,
			label: `${entity.name}`,
			currentValue: price(entity.output),
			description: `${priceId}：输出 ${price(entity.output)} · 输入 未缓存 ${price(entity.input.miss)} / 缓存 ${price(entity.input.hit)}`,
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				return new PriceFormPage({
					draft,
					priceId,
					theme,
					refreshStatus,
					onDone: finish,
					getContainerRef,
				});
			},
		}));

		items.unshift({
			id: "__newprice",
			label: "＋ 新建价格实体",
			currentValue: "",
			description: "新建价格实体（初值 0，建后用菜单改数值）",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				this.askText(tui, theme, {
					title: "新价格实体 id（如 vendor-peak）",
					placeholder: "vendor-peak",
					notes: ["建议：小写字母、数字与连字符；不能与已有价格实体重复"],
					validate: (raw) => {
						const id = raw.trim();
						if (id === "") return "价格 id 不能为空";
						if (draft.snapshot().prices[id]) return `价格实体已存在：${id}`;
						return null;
					},
					onSubmit: (value) => {
						const id = value.trim();
						draft.upsertPrice(id, { name: id, input: { miss: 0, hit: 0 }, output: 0 });
						refreshStatus(`已新建价格 ${id}（初值 0，请改数值；Ctrl+S 保存）`);
						finish();
					},
					onCancel: () => { refreshStatus("已取消新建价格"); finish(); },
				});
				return this.buildTextPage("正在输入新价格实体 id…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/** 管理面：日历注册表（编辑日期 / 改名 / 删除） */
	private buildCalendarRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		getContainerRef: () => Component,
		goBack: () => void,
	): SettingsList {
		const items: SettingItem[] = Object.entries(draft.snapshot().calendars).map(([calId, entry]) => ({
			id: calId,
			label: `${entry.name}`,
			currentValue: `${entry.dates.length} 天`,
			description: `${calId}：${entry.dates.slice(0, 6).join("、")}${entry.dates.length > 6 ? " …" : ""}`,
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				const calItems: SettingItem[] = [
					{
						id: "dates",
						label: "编辑日期",
						currentValue: `${entry.dates.length} 天`,
						description: "添加 / 移除 MM-DD 或 YYYY-MM-DD",
						submenu: (_vv, ddone) => {
							enterLevel();
							const dfinish = (): void => { leaveLevel(); ddone(undefined); };
							return buildDatesEditor(entry.dates, theme,
								(req) => this.askText(tui, theme, {
									title: req.title,
									placeholder: req.placeholder,
									notes: req.notes,
									initialValue: req.initialValue,
									validate: req.validate,
									onSubmit: req.onSubmit,
									onCancel: () => refreshStatus("已取消输入"),
								}),
								(result) => {
									draft.setCalendarDates(calId, result);
									refreshStatus(`日历 ${calId} 日期已更新为 ${result.length} 天（Ctrl+S 保存）`);
									dfinish();
								},
								getContainerRef,
							);
						},
					},
					{
						id: "rename",
						label: "重命名",
						currentValue: entry.name,
						description: "留空回退为 id",
						submenu: (_vv, ddone) => {
							enterLevel();
							const rfinish = (): void => { leaveLevel(); ddone(undefined); };
							this.askText(tui, theme, {
								title: `日历 ${calId} 的新名称`,
								initialValue: entry.name,
								placeholder: entry.name,
								notes: ["留空则回退为 id"],
								onSubmit: (value) => {
									draft.setCalendarName(calId, value);
									refreshStatus(`日历 ${calId} 已改名（Ctrl+S 保存）`);
									rfinish();
								},
								onCancel: () => { refreshStatus("已取消改名"); },
							});
							return this.buildTextPage("正在输入新名称…", rfinish);
						},
					},
					{
						id: "delete",
						label: "删除该日历",
						currentValue: "",
						description: "被规则引用时保存会被拒",
						submenu: (_vv, ddone) => {
							enterLevel();
							const dfinish = (): void => { leaveLevel(); ddone(undefined); };
							return new ActionMenu(
								`确认删除日历 ${calId}？`,
								[{
									label: "确认删除",
									run: () => {
										draft.deleteCalendar(calId);
										refreshStatus(`已删除日历 ${calId}（Ctrl+S 保存）`);
										dfinish();
									},
								}],
								theme,
								dfinish,
							);
						},
					},
				];
				return new SettingsList(calItems, Math.min(calItems.length + 4, 10), getSettingsListTheme(), () => {}, finish);
			},
		}));

		items.unshift({
			id: "__newcal",
			label: "＋ 新建日历",
			currentValue: "",
			description: "新建日历（逗号分隔日期，支持 YYYY-MM-DD 与 MM-DD）",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				this.askText(tui, theme, {
					title: "新日历 id（如 cn-holiday）",
					placeholder: "cn-holiday",
					notes: ["建议：小写字母、数字与连字符；不能与已有日历重复"],
					validate: (raw) => {
						const id = raw.trim();
						if (id === "") return "日历 id 不能为空";
						if (draft.snapshot().calendars[id]) return `日历已存在：${id}`;
						return null;
					},
					onSubmit: (value) => {
						const id = value.trim();
						// 第二步：日期。此时 draft 尚未写入，取消即整体放弃（不留半创建状态）
						this.askText(tui, theme, {
							title: `${id} 的日期（逗号分隔）`,
							placeholder: "01-01, 10-01",
							notes: ["MM-DD 每年循环（如 01-01）；YYYY-MM-DD 精确一次（如 2026-10-01）；逗号分隔多个"],
							validate: (raw) => {
								const dates = raw.split(/[,，\s]+/).filter(Boolean);
								if (dates.length === 0) return "至少需要一个日期";
								const bad = dates.find((d) => !isValidCalendarDate(d));
								return bad ? `无效日期：${bad}（需 YYYY-MM-DD 或 MM-DD）` : null;
							},
							onSubmit: (rawDates) => {
								const dates = rawDates.split(/[,，\s]+/).filter(Boolean);
								draft.upsertCalendar(id, { name: id, dates });
								refreshStatus(`已新建日历 ${id}（${dates.length} 天；Ctrl+S 保存）`);
								finish();
							},
							onCancel: () => { refreshStatus("已取消新建日历"); finish(); },
						});
					},
					onCancel: () => { refreshStatus("已取消新建日历"); finish(); },
				});
				return this.buildTextPage("正在输入新日历信息…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/**
	 * 文本输入统一入口：弹出 PromptOverlay 覆盖层。
	 *
	 * 生命周期铁律（漏一半就会"Esc 卡屏"）：
	 * - 提交走 onSubmit，取消走 onCancel，**两条路径都必须关闭覆盖层**
	 * - 必须接住 showOverlay 返回的 handle 才能在回调里 hide()
	 * - 嵌套输入（如日历两步）先关旧的再开新的，避免第一层残留
	 *
	 * 取消语义：不写入 draft，仅提示"已取消"并回退（由各调用点传入 onCancel）。
	 * 无 overlay 能力（单测/降级）时不阻塞流程（由调用方返回 buildTextPage）。
	 */
	private askText(
		tui: DrawerTui,
		theme: DrawerTheme,
		options: {
			title: string;
			notes?: string[];
			placeholder?: string;
			initialValue?: string;
			validate?: (value: string) => string | null;
			onSubmit: (value: string) => void;
			onCancel?: () => void;
		},
	): void {
		if (typeof tui.showOverlay !== "function") {
			return;
		}
		this.closeOverlay();
		const prompt = new PromptOverlay({
			title: options.title,
			notes: options.notes,
			placeholder: options.placeholder,
			initialValue: options.initialValue,
			validate: options.validate,
			onSubmit: (value) => {
				this.closeOverlay();
				options.onSubmit(value);
			},
			onCancel: () => {
				this.closeOverlay();
				options.onCancel?.();
			},
		}, theme);
		const handle = tui.showOverlay(prompt, { width: 64, anchor: "bottom-center" });
		if (this.overlaySlot) {
			this.overlaySlot.current = {
				hide: () => handle?.hide?.(),
				dispose: () => prompt.dispose?.(),
			};
		}
	}

	/** 关闭当前输入覆盖层（幂等）；submit / cancel 两条路径与场景互斥守卫共用 */
	private closeOverlay(): void {
		const handle = this.overlaySlot?.current;
		if (!handle) return;
		this.overlaySlot!.current = null;
		handle.hide();
		handle.dispose?.();
	}

	/** 纯文本页（只读）：Esc 返回 */
	private buildTextPage(body: string, goBack: () => void): Component {
		const lines = body.split("\n");
		const kb = getKeybindings();
		return {
			render: () => lines,
			invalidate: () => {},
			handleInput: (data: string) => {
				if (kb.matches(data, "tui.select.cancel")) goBack();
			},
		};
	}

}
