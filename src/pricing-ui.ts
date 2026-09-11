/**
 * 表现层：三级钻取抽屉（厂商 → 模型 → 详情）+ 编辑会话。
 *
 * 交互契约（对应 DESIGN.md Editor）：
 * - 编辑先写内存（PricingDraft），Ctrl+S 全量落盘，Ctrl+R 丢弃未保存改动
 * - 下钻沿用 SettingsList 原生 submenu（Enter 进入子级，Esc 逐级返回），搜索可过滤
 * - 绑定优先级排序不走 TUI（SettingsList 不暴露选中索引），由 /price move 承担
 * - 无 TUI（headless）时 open() 返回 false，由接线层回退成 /price list 文本
 */

import { DynamicBorder, getSettingsListTheme, ExtensionInputComponent } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	SettingsList,
	Text,
	type Component,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { listProviderRows, listProviderPlans } from "./pricing-builder.ts";
import { renderModelDetail, renderResolveResult } from "./pricing-format.ts";
import { PricingDraft } from "./pricing-draft.ts";
import { describeSchedule, price } from "./pricing-desc.ts";

/** 抽屉第 0 级的标题（返回厂商列表时恢复） */
const ROOT_TITLE = "模型计费配置 · 厂商";

/** 抽屉标题的层级格式 */
function levelTitle(crumb: string): string {
	return `模型计费配置 · ${crumb}`;
}

/** 抽屉主题（fg/bold 的最小依赖面） */
interface DrawerTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
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

/** 校验解析时间输入："YYYY-MM-DDTHH:mm"（也接受 "YYYY-MM-DD"，按当天 12:00） */
function parseDateTimeInput(raw: string): Date | null {
	const text = raw.trim();
	if (text === "") return null;
	const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T12:00` : text;
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) return null;
	const date = new Date(`${normalized}:00`);
	return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 校验日历日期：形状（YYYY-MM-DD | MM-DD）+ 真实范围（月份 1-12，日按月份）。
 * 仅用正则匹配形状会放过 2026-13-99 这类"形状正确但不存在"的日期。
 */
export function isValidCalendarDate(raw: string): boolean {
	const m = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(raw);
	if (!m) return false;
	const month = Number(m[1]);
	const day = Number(m[2]);
	if (month < 1 || month > 12) return false;
	// 2 月按闰年上限 29 取，避免误拒合法的 02-29
	const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
	return day >= 1 && day <= maxDay;
}

/** 校验价格输入：支持 "4"、"4.5"、"¥0.02" */
function parsePriceInput(raw: string): number | null {
	const cleaned = raw.replace(/^¥/, "").trim();
	const num = Number(cleaned);
	if (!Number.isFinite(num) || num < 0) return null;
	return num;
}

/**
 * 抽屉初始页：默认只显示模型（根层职责单一），管理面由子命令直达。
 * 命名与 CLI 子命令一致（scheme / rate / calendar），见 AGENTS.md v0.7 决策。
 */
export type DrawerPage = "models" | "scheme" | "rate" | "calendar";

/** 各初始页的根标题（Esc 回到此层时恢复） */
const PAGE_TITLES: Record<DrawerPage, string> = {
	models: ROOT_TITLE,
	scheme: "模型计费配置 · 方案",
	rate: "模型计费配置 · 价格",
	calendar: "模型计费配置 · 日历",
};

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
	async open(context: unknown, page: DrawerPage = "models"): Promise<boolean> {
		const ui = (context as { ui?: { custom?: unknown } })?.ui;
		if (typeof ui?.custom !== "function") return false;
		await (ui.custom as (factory: unknown) => Promise<unknown>)((tui: unknown, theme: DrawerTheme, _kb: unknown, done: (result?: undefined) => void) => {
			return this.buildScene(tui as DrawerTui, theme, () => done(undefined), page);
		});
		return true;
	}

	/**
	 * 组装抽屉场景（边框 + 动态标题 + 状态栏 + 第 0 级厂商列表）。
	 * Ctrl+S / Ctrl+R 在顶层拦截，保证任意层级都能保存/重置。
	 */
	private buildScene(tui: DrawerTui, theme: DrawerTheme, close: () => void, initialPage: DrawerPage = "models"): Component {
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
			refreshStatus(result.ok ? "已写入 ~/.pi/model-pricing.json" : theme.fg("error", `保存被拒：${result.reason}`));
			if (result.ok) rebuildRoot();
		};

		/** 重置：丢弃未保存改动 */
		const reset = (): void => {
			draft.reset();
			escHintShown = false;
			rebuildRoot();
			refreshStatus("已丢弃未保存改动");
		};

		let rootList: SettingsList | null = null;

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
		 * 重建根列表（保存/重置后价格列需要刷新）。
		 * 按初始页分派：models = 厂商列表；其余 = 对应注册表（子命令直达用）。
		 */
		const rebuildRoot = (): void => {
			if (rootList) container.removeChild(rootList);
			rootList = this.buildRootList(initialPage, draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, pushPage, popPage, close);
			container.addChild(rootList);
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
				// Ctrl+S / Ctrl+R：任意层级可用，优先于列表导航
				if (data === "\u0013") {
					save();
					return;
				}
				if (data === "\u0012") {
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
				// 输入覆盖层打开时：底层（pageStack / rootList）一律不响应，避免同一按键双重处理
				if (hasOverlay()) return;
				// 临时页栈优先；栈顶的 buildTextPage 在 Esc 时会调用 popPage
				const top = pageStack[pageStack.length - 1];
				if (top) {
					top.handleInput?.(data);
					return;
				}
				rootList?.handleInput?.(data);
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
		goBack: () => void,
	): SettingsList {
		void pushPage;
		void popPage;
		switch (page) {
			case "scheme":
				return this.buildPlanRegistry(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, goBack);
			case "rate":
				return this.buildPriceRegistry(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, goBack);
			case "calendar":
				return this.buildCalendarRegistry(draft, tui, theme, refreshStatus, enterLevel, leaveLevel, goBack);
			default:
				return this.buildProviderList(draft, tui, theme, setTitle, refreshStatus, enterLevel, leaveLevel, pushPage, popPage, goBack);
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
					? `优先级 #${order + 1}${firstHint}｜${binding.plan}：${plan.rules.map((r) => describeSchedule(r.schedule)).join(" ; ")}｜排序用 /price move`
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
				description: "选择后追加到末尾（最低优先级）；排序用 /price move",
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
					const body = renderResolveResult(modelId, providerId, at, this.filePath);
					setTitle(levelTitle(`${providerId}/${modelId}/resolve`));
					pushPage(this.buildTextPage(body, () => {
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
							run: () => this.askText(tui, "解析时间（YYYY-MM-DDTHH:mm）", "2026-09-16T10:00", (value) => {
								const parsed = parseDateTimeInput(value);
								if (!parsed) {
									refreshStatus(theme.fg("error", `无效时间: ${value}（格式 YYYY-MM-DDTHH:mm）`));
									finish();
									return;
								}
								showChain(parsed);
							}, () => refreshStatus("已取消输入")),
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
				return this.buildTextPage(renderModelDetail(providerId, modelId, this.filePath), () => {
					setTitle(levelTitle(`${providerId}/${modelId}`));
					leaveLevel();
					done(undefined);
				});
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

	/** 别名输入：走 ExtensionInputComponent 覆盖层 */
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
		const input = new ExtensionInputComponent(
			"设置别名（留空清除）",
			current || "如 deepseek-v4-flash",
			(value) => {
				draft.setAlias(providerId, modelId, value);
				refreshStatus(`别名已改为 ${value || "（清除）"}（Ctrl+S 保存）`);
				done(undefined);
			},
			() => done(undefined),
			{ tui: tui as never },
		);
		tui.showOverlay?.(input, { width: 60, anchor: "center" });
		// 无 overlay 能力（测试/降级）时直接返回输入组件本身
		return input;
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
				return this.buildPlanActions(draft, tui, theme, planId, setTitle, refreshStatus, enterLevel, leaveLevel, () => {
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
				this.askText(tui, "新方案 id（如 my-plan）", "my-plan", (planId) => {
					const id = planId.trim();
					if (id === "") { refreshStatus(theme.fg("error", "方案 id 不能为空")); finish(); return; }
					if (draft.snapshot().plans[id]) { refreshStatus(theme.fg("error", `方案已存在: ${id}`)); finish(); return; }
					const firstPrice = Object.keys(draft.snapshot().prices)[0];
					if (!firstPrice) { refreshStatus(theme.fg("error", "价格注册表为空，请先新建价格实体")); finish(); return; }
					draft.upsertPlan(id, {
						name: id,
						rules: [{ schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] }, price: firstPrice }],
					});
					refreshStatus(`已新建方案 ${id}（默认挂 ${firstPrice}；Ctrl+S 保存）`);
					finish();
				}, () => { refreshStatus("已取消新建方案"); finish(); });
				return this.buildTextPage("正在输入新方案 id…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/** 管理面：单个方案的操作（改规则价格 / 有效期 / 加删规则 / 复制 / 删除） */
	private buildPlanActions(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		planId: string,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
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
					return this.buildRuleActions(draft, tui, theme, planId, i, refreshStatus, enterLevel, leaveLevel, () => {
						setTitle(levelTitle(`方案/${planId}`));
						leaveLevel();
						done(undefined);
					});
				},
			});
		});

		items.push({
			id: "__ops",
			label: "方案操作（追加规则 / 复制 / 删除）",
			currentValue: "",
			description: "追加规则、复制方案、删除方案",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				return new ActionMenu(
				`方案 ${planId} 操作`,
				[
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

	/** 管理面：单条规则的操作（改价格引用 / 有效期 / 删除） */
	private buildRuleActions(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		planId: string,
		ruleIndex: number,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
		goBack: () => void,
	): SettingsList {
		const rule = draft.snapshot().plans[planId]?.rules[ruleIndex];
		const items: SettingItem[] = [];

		// 价格引用选择
		for (const [priceId, entity] of Object.entries(draft.snapshot().prices)) {
			items.push({
				id: `price:${priceId}`,
				label: `${rule?.price === priceId ? "◉" : "◯"} ${entity.name}`,
				currentValue: price(entity.output),
				description: `改用价格实体 ${priceId}`,
			});
		}
		items.push({
			id: "__valid",
			label: "设置有效期",
			currentValue: rule?.validUntil ?? "无",
			description: "YYYY-MM-DD，过期后规则不参与匹配（留空清除）",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				this.askText(tui, "规则有效期（YYYY-MM-DD，留空清除）", rule?.validUntil ?? "", (value) => {
					if (value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
						refreshStatus(theme.fg("error", `无效日期: ${value}（需 YYYY-MM-DD）`));
						finish();
						return;
					}
					draft.setRuleValidUntil(planId, ruleIndex, value);
					refreshStatus(`规则 #${ruleIndex} 有效期设为 ${value || "无"}（Ctrl+S 保存）`);
					finish();
				}, () => { refreshStatus("已取消输入"); finish(); });
				return this.buildTextPage("编辑器已打开（若终端不支持覆盖层，请改用 /price scheme 命令）", finish);
			},
		});
		items.push({
			id: "__del",
			label: "删除该规则",
			currentValue: "",
			description: "方案至少保留一条规则",
			submenu: (_v, done) => {
				enterLevel();
				const finish = (): void => { leaveLevel(); done(undefined); };
				return new ActionMenu(
					`删除规则 #${ruleIndex}？`,
					[{
						label: "确认删除",
						detail: "方案至少保留一条规则",
						run: () => {
							if (!draft.removeRule(planId, ruleIndex)) {
								refreshStatus(theme.fg("error", "删除失败：方案至少保留一条规则"));
							} else {
								refreshStatus(`已删除规则 #${ruleIndex}（Ctrl+S 保存）`);
							}
							finish();
						},
					}],
					theme,
					finish,
				);
			},
		});

		return new SettingsList(items, Math.min(items.length + 4, 14), getSettingsListTheme(), (id) => {
			if (id.startsWith("price:")) {
				draft.setRulePrice(planId, ruleIndex, id.slice(6));
				refreshStatus(`规则 #${ruleIndex} 价格改为 ${id.slice(6)}（Ctrl+S 保存）`);
				goBack();
			}
		}, goBack);
	}

	/** 管理面：价格注册表（编辑数值 / 删除） */
	private buildPriceRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
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
				return new ActionMenu(
					`价格 ${priceId}（${entity.name}）`,
					[
						{ label: "改输出价", detail: price(entity.output), run: () => { this.askPriceField(tui, theme, draft, priceId, "output", "输出价（¥/百万 token）", refreshStatus, finish); } },
						{ label: "改未缓存输入价", detail: price(entity.input.miss), run: () => { this.askPriceField(tui, theme, draft, priceId, "input.miss", "未缓存输入价（¥/百万 token）", refreshStatus, finish); } },
						{ label: "改缓存命中输入价", detail: price(entity.input.hit), run: () => { this.askPriceField(tui, theme, draft, priceId, "input.hit", "缓存命中输入价（¥/百万 token）", refreshStatus, finish); } },
						{ label: "删除该价格", detail: "被规则引用时保存会被拒", run: () => { draft.deletePrice(priceId); refreshStatus(`已删除价格 ${priceId}（Ctrl+S 保存）`); finish(); } },
					],
					theme,
					finish,
				);
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
				this.askText(tui, "新价格实体 id（如 vendor-peak）", "vendor-peak", (priceId) => {
					const id = priceId.trim();
					if (id === "") { refreshStatus(theme.fg("error", "价格 id 不能为空")); finish(); return; }
					if (draft.snapshot().prices[id]) { refreshStatus(theme.fg("error", `价格实体已存在: ${id}`)); finish(); return; }
					draft.upsertPrice(id, { name: id, input: { miss: 0, hit: 0 }, output: 0 });
					refreshStatus(`已新建价格 ${id}（初值 0，请改数值；Ctrl+S 保存）`);
					finish();
				}, () => { refreshStatus("已取消新建价格"); finish(); });
				return this.buildTextPage("正在输入新价格实体 id…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/** 单个价格字段的输入：校验后写入 draft */
	private askPriceField(
		tui: DrawerTui,
		theme: DrawerTheme,
		draft: PricingDraft,
		priceId: string,
		field: "input.miss" | "input.hit" | "output",
		label: string,
		refreshStatus: (msg?: string) => void,
		done: (selectedValue?: string) => void,
	): void {
		const entity = draft.snapshot().prices[priceId];
		if (!entity) return;
		const current = field === "output" ? entity.output : entity.input[field === "input.miss" ? "miss" : "hit"];
		this.askText(tui, `${priceId} ${label}`, String(current), (value) => {
			const parsed = parsePriceInput(value);
			if (parsed === null) {
				refreshStatus(theme.fg("error", `无效价格: ${value}`));
			} else {
				draft.setPriceField(priceId, field, parsed);
				refreshStatus(`${priceId} ${label} = ${price(parsed)}（Ctrl+S 保存）`);
			}
			done(undefined);
		}, () => { refreshStatus("已取消输入"); done(undefined); });
	}

	/** 管理面：日历注册表（每条日历可删除） */
	private buildCalendarRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		refreshStatus: (msg?: string) => void,
		enterLevel: () => void,
		leaveLevel: () => void,
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
				return new ActionMenu(
					`日历 ${calId}（${entry.name}）`,
					[{
						label: "删除该日历",
						detail: "被规则引用时保存会被拒",
						run: () => { draft.deleteCalendar(calId); refreshStatus(`已删除日历 ${calId}（Ctrl+S 保存）`); finish(); },
					}],
					theme,
					finish,
				);
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
				this.askText(tui, "新日历 id（如 cn-holiday）", "cn-holiday", (calId) => {
					const id = calId.trim();
					if (id === "") { refreshStatus(theme.fg("error", "日历 id 不能为空")); finish(); return; }
					if (draft.snapshot().calendars[id]) { refreshStatus(theme.fg("error", `日历已存在: ${id}`)); finish(); return; }
					// 第二步：日期。此时 draft 尚未写入，取消即整体放弃（不留半创建状态）
					this.askText(tui, `${id} 的日期（逗号分隔）`, "01-01, 10-01", (rawDates) => {
						const dates = rawDates.split(/[,，\s]+/).filter(Boolean);
						if (dates.length === 0) { refreshStatus(theme.fg("error", "至少需要一个日期")); finish(); return; }
						const bad = dates.find((d) => !isValidCalendarDate(d));
						if (bad) { refreshStatus(theme.fg("error", `无效日期: ${bad}（需 YYYY-MM-DD 或 MM-DD）`)); finish(); return; }
						draft.upsertCalendar(id, { name: id, dates });
						refreshStatus(`已新建日历 ${id}（${dates.length} 天；Ctrl+S 保存）`);
						finish();
					}, () => { refreshStatus("已取消新建日历"); finish(); });
				}, () => { refreshStatus("已取消新建日历"); finish(); });
				return this.buildTextPage("正在输入新日历信息…", finish);
			},
		});
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/**
	 * 文本输入统一入口：走 ExtensionInputComponent 覆盖层。
	 *
	 * 生命周期铁律（漏一半就会"Esc 卡屏"）：
	 * - 提交走 onSubmit，取消走 onCancel，**两条路径都必须关闭覆盖层**
	 * - 必须接住 showOverlay 返回的 handle 才能在回调里 hide()
	 * - 嵌套输入（如日历两步）先关旧的再开新的，避免第一层残留
	 *
	 * 取消语义：不写入 draft，仅提示"已取消"并回退（由各调用点传入 onCancel）。
	 * 无 overlay 能力（单测/降级）时直接同步调用 onSubmit，便于断言。
	 */
	private askText(
		tui: DrawerTui,
		title: string,
		placeholder: string,
		onSubmit: (value: string) => void,
		onCancel?: () => void,
	): void {
		if (typeof tui.showOverlay !== "function") {
			// 降级：无法弹层，交由调用方决定（这里不阻塞流程）
			return;
		}
		this.closeOverlay();
		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => {
				this.closeOverlay();
				onSubmit(value);
			},
			() => {
				this.closeOverlay();
				onCancel?.();
			},
			{ tui: tui as never },
		);
		const handle = tui.showOverlay(input, { width: 64, anchor: "center" });
		if (this.overlaySlot) {
			this.overlaySlot.current = {
				hide: () => handle?.hide?.(),
				dispose: () => (input as { dispose?: () => void }).dispose?.(),
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
