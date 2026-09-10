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
import { listProviderRows, listProviderPlans } from "./pricing-builder.ts";import { renderModelDetail, renderPlanDetail, renderPriceRegistry, renderCalendarList, renderResolveResult } from "./pricing-format.ts";
import { resolveDebug } from "./pricing-query.ts";
import { PricingDraft } from "./pricing-draft.ts";
import { describeSchedule, price } from "./pricing-desc.ts";
import type { PricingSchema } from "./pricing-types.ts";

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

/** 可传入的 TUI 子集（只用到 showOverlay / setFocus） */
interface DrawerTui {
	showOverlay?: (component: Component, options?: unknown) => { hide?: () => void };
	setFocus?: (component: Component | null) => void;
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

/** 校验价格输入：支持 "4"、"4.5"、"¥0.02" */
function parsePriceInput(raw: string): number | null {
	const cleaned = raw.replace(/^¥/, "").trim();
	const num = Number(cleaned);
	if (!Number.isFinite(num) || num < 0) return null;
	return num;
}

/**
 * 三级钻取抽屉：独立于命令层，filePath 注入便于测试；不访问 pi ExtensionAPI。
 */
export class PricingDrawer {
	constructor(private readonly filePath?: string) {}

	/** 打开抽屉；无 custom UI 时返回 false，交给命令层回退文本输出 */
	async open(context: unknown): Promise<boolean> {
		const ui = (context as { ui?: { custom?: unknown } })?.ui;
		if (typeof ui?.custom !== "function") return false;
		await (ui.custom as (factory: unknown) => Promise<unknown>)((tui: unknown, theme: DrawerTheme, _kb: unknown, done: (result?: undefined) => void) => {
			return this.buildScene(tui as DrawerTui, theme, () => done(undefined));
		});
		return true;
	}

	/**
	 * 组装抽屉场景（边框 + 动态标题 + 状态栏 + 第 0 级厂商列表）。
	 * Ctrl+S / Ctrl+R 在顶层拦截，保证任意层级都能保存/重置。
	 */
	private buildScene(tui: DrawerTui, theme: DrawerTheme, close: () => void): Component {
		const draft = new PricingDraft(this.filePath);
		const container = new Container();
		const title = new Text(theme.fg("accent", theme.bold(ROOT_TITLE)), 1, 1);
		/** 换标题并强制重绘（submenu 钻取/返回时调用）；同时更新子菜单状态 */
		const setTitle = (text: string): void => {
			insideSubmenu = text !== ROOT_TITLE;
			title.setText(theme.fg("accent", theme.bold(text)));
			container.invalidate();
		};

		/** 状态栏文案：未保存改动 / 保存结果提示 */
		let status = "";
		const statusText = new Text("", 1, 0);
		const refreshStatus = (message = ""): void => {
			status = message;
			const dirty = draft.isDirty;
			const left = dirty ? theme.fg("warning", `● 未保存改动（${draft.changedAreas.join("、")}）`) : theme.fg("success", "✓ 已保存");
			const detail = status ? `   ${status}` : "";
			const keys = theme.fg("dim", "  Ctrl+S 保存 · Ctrl+R 重置 · Esc 返回");
			statusText.setText(`${left}${detail}${keys}`);
			container.invalidate();
		};

		/** 保存：校验失败只提示，不退出编辑器 */
		const save = (): void => {
			const result = draft.save();
			refreshStatus(result.ok ? "已写入 ~/.pi/model-pricing.json" : theme.fg("error", `保存被拒：${result.reason}`));
			if (result.ok) rebuildRoot();
		};

		/** 重置：丢弃未保存改动 */
		const reset = (): void => {
			draft.reset();
			rebuildRoot();
			refreshStatus("已丢弃未保存改动");
		};

		let rootList: SettingsList | null = null;
		/**
		 * 当前是否处于子菜单（submenu 展开时 Esc 归子级，根层不拦截）。
		 * SettingsList 不暴露该状态，这里借标题层级推断：标题回到 ROOT_TITLE 即回到根层。
		 */
		let insideSubmenu = false;

		/** 重建厂商列表（保存/重置后价格列需要刷新） */
		const rebuildRoot = (): void => {
			if (rootList) container.removeChild(rootList);
			rootList = this.buildProviderList(draft, tui, theme, setTitle, refreshStatus, close);
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
				// 根层 Esc + 有未保存改动：先提示如何处置，避免误退出丢改动
				if (kb.matches(data, "tui.select.cancel") && draft.isDirty && !insideSubmenu) {
					refreshStatus(theme.fg("warning", "有未保存改动：Ctrl+S 保存 / Ctrl+R 重置 / 再按 Esc 放弃退出"));
					return;
				}
				rootList?.handleInput?.(data);
			},
		};
	}

	/** 第 0 级：厂商列表（Enter 下钻到该厂商的模型列表） */
	private buildProviderList(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		refreshStatus: (msg?: string) => void,
		close: () => void,
	): SettingsList {
		const rows = listProviderRows(this.filePath);
		const items: SettingItem[] = rows.map((row) => ({
			id: row.providerId,
			label: `${row.providerId}  (${row.modelCount}模型 · ${row.planDesc})`,
			currentValue: "",
			description: row.description,
			submenu: (_currentValue, done) => {
				setTitle(levelTitle(row.providerId));
				return this.buildModelList(draft, tui, theme, row.providerId, setTitle, refreshStatus, () => {
					setTitle(ROOT_TITLE);
					done(undefined);
				});
			},
		}));

		// 管理面入口（第 0 级尾部）：方案 / 价格 / 日历 / 解析调试
		items.push({
			id: "__plans",
			label: "方案注册表",
			currentValue: `${Object.keys(draft.snapshot().plans).length} 个`,
			description: "计费方案：规则顺序即优先级（first match wins）",
			submenu: (_v, done) => {
				setTitle("模型计费配置 · 方案");
				return this.buildPlanRegistry(draft, tui, theme, setTitle, refreshStatus, () => {
					setTitle(ROOT_TITLE);
					done(undefined);
				});
			},
		});
		items.push({
			id: "__prices",
			label: "价格注册表",
			currentValue: `${Object.keys(draft.snapshot().prices).length} 个`,
			description: "可复用价格实体（¥/百万 token）",
			submenu: (_v, done) => {
				setTitle("模型计费配置 · 价格");
				return this.buildPriceRegistry(draft, tui, theme, setTitle, refreshStatus, () => {
					setTitle(ROOT_TITLE);
					done(undefined);
				});
			},
		});
		items.push({
			id: "__calendars",
			label: "日历注册表",
			currentValue: `${Object.keys(draft.snapshot().calendars).length} 个`,
			description: "节假日/特殊日期资源，可被 schedule 引用",
			submenu: (_v, done) => {
				setTitle("模型计费配置 · 日历");
				return this.buildCalendarRegistry(draft, tui, theme, setTitle, () => {
					setTitle(ROOT_TITLE);
					done(undefined);
				});
			},
		});
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
					setTitle(levelTitle(`${providerId}/${modelId}`));
					return this.buildModelDetail(draft, tui, theme, providerId, modelId, setTitle, refreshStatus, () => {
						setTitle(levelTitle(providerId));
						done(undefined);
					});
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
		goBack: () => void,
	): SettingsList {
		const schema = draft.snapshot();
		const conf = schema.providers[providerId]?.models[modelId];
		const items: SettingItem[] = [];

		if (!conf) {
			items.push({ id: "__missing", label: "模型不存在", currentValue: "", description: `${providerId}/${modelId} 未在配置中` });
			return new SettingsList(items, 6, getSettingsListTheme(), () => {}, goBack);
		}

		// 每条绑定：Enter 进入该项的操作子菜单
		for (const binding of conf.plans) {
			const plan = schema.plans[binding.plan];
			items.push({
				id: `bind:${binding.plan}`,
				label: `${binding.enabled ? "◉" : "◌"} ${plan?.name ?? binding.plan}`,
				currentValue: binding.enabled ? "已启用" : "已禁用",
				description: plan
					? `${binding.plan}：${plan.rules.map((r) => describeSchedule(r.schedule)).join(" ; ")}`
					: `${binding.plan}（方案不存在）`,
				submenu: (_v, done) => this.buildBindingActions(draft, theme, providerId, modelId, binding.plan, refreshStatus, () => {
					setTitle(levelTitle(`${providerId}/${modelId}`));
					done(undefined);
				}),
			});
		}

		// 追加绑定
		const unbound = listProviderPlans().filter((p) => !conf.plans.some((b) => b.plan === p.id));
		if (unbound.length > 0) {
			items.push({
				id: "__add",
				label: "＋ 绑定新方案",
				currentValue: `${unbound.length} 可选`,
				description: "选择后追加到末尾（最低优先级）；排序用 /price move",
				submenu: (_v, done) => this.buildAddBinding(draft, theme, providerId, modelId, unbound, refreshStatus, done),
			});
		}

		// 别名编辑
		items.push({
			id: "__alias",
			label: "别名（台账匹配）",
			currentValue: conf.alias ?? "（未设置）",
			description: "pi 内部 model 名的别名，用于 pi-prompt / pi-usage 台账匹配",
			submenu: (_v, done) => this.buildAliasInput(tui, theme, draft, providerId, modelId, refreshStatus, done),
		});

		// 解析调试（实时命中链）
		items.push({
			id: "__resolve",
			label: "解析调试（当前命中链）",
			currentValue: "",
			description: "展示 first-match 过程：哪条规则命中/未中及原因",
			submenu: (_v, done) => {
				setTitle(levelTitle(`${providerId}/${modelId}/resolve`));
				return this.buildTextPage(renderResolveResult(modelId, providerId, undefined, this.filePath), () => {
					setTitle(levelTitle(`${providerId}/${modelId}`));
					done(undefined);
				});
			},
		});

		// 只读详情（保留原有纯文本视图）
		items.push({
			id: "__detail",
			label: "查看只读详情",
			currentValue: "",
			description: "含基准/覆盖档与实时生效价",
			submenu: (_v, done) => {
				setTitle(levelTitle(`${providerId}/${modelId}`));
				return this.buildTextPage(renderModelDetail(providerId, modelId, this.filePath), () => {
					setTitle(levelTitle(`${providerId}/${modelId}`));
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
		goBack: () => void,
	): SettingsList {
		const schema = draft.snapshot();
		const items: SettingItem[] = Object.entries(schema.plans).map(([planId, plan]) => ({
			id: planId,
			label: `${plan.name}`,
			currentValue: `${plan.rules.length} 规则`,
			description: `${planId}：${plan.rules.map((r) => describeSchedule(r.schedule)).join(" ; ")}`,
			submenu: (_v, done) => {
				setTitle(levelTitle(`方案/${planId}`));
				return this.buildPlanActions(draft, tui, theme, planId, setTitle, refreshStatus, () => {
					setTitle(levelTitle("方案"));
					done(undefined);
				});
			},
		}));
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
					setTitle(levelTitle(`方案/${planId}/规则#${i}`));
					return this.buildRuleActions(draft, tui, theme, planId, i, refreshStatus, () => {
						setTitle(levelTitle(`方案/${planId}`));
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
			submenu: (_v, done) => new ActionMenu(
				`方案 ${planId} 操作`,
				[
					{
						label: "＋ 追加规则",
						detail: "复制最后一条规则的形状",
						run: () => { draft.addRule(planId); refreshStatus("已追加规则（Ctrl+S 保存）"); done(undefined); },
					},
					{
						label: "复制方案",
						detail: "生成 <id>-copy",
						run: () => { const n = draft.duplicatePlan(planId); refreshStatus(n ? `已复制为 ${n}（Ctrl+S 保存）` : "复制失败"); done(undefined); },
					},
					{
						label: "删除方案",
						detail: "被模型绑定时会拒绝保存",
						run: () => { draft.deletePlan(planId); refreshStatus(`已删除方案 ${planId}（Ctrl+S 保存）`); done(undefined); },
					},
				],
				theme,
				() => done(undefined),
			),
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
				this.askText(tui, "规则有效期（YYYY-MM-DD，留空清除）", rule?.validUntil ?? "", (value) => {
					if (value !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
						refreshStatus(theme.fg("error", `无效日期: ${value}（需 YYYY-MM-DD）`));
						done(undefined);
						return;
					}
					draft.setRuleValidUntil(planId, ruleIndex, value);
					refreshStatus(`规则 #${ruleIndex} 有效期设为 ${value || "无"}（Ctrl+S 保存）`);
					done(undefined);
				});
				return this.buildTextPage("编辑器已打开（若终端不支持覆盖层，请改用 /price plan 命令）", () => done(undefined));
			},
		});
		items.push({
			id: "__del",
			label: "删除该规则",
			currentValue: "",
			description: "方案至少保留一条规则",
			submenu: (_v, done) => new ActionMenu(
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
						done(undefined);
					},
				}],
				theme,
				() => done(undefined),
			),
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
		goBack: () => void,
	): SettingsList {
		const items: SettingItem[] = Object.entries(draft.snapshot().prices).map(([priceId, entity]) => ({
			id: priceId,
			label: `${entity.name}`,
			currentValue: price(entity.output),
			description: `${priceId}：输出 ${price(entity.output)} · 输入 未缓存 ${price(entity.input.miss)} / 缓存 ${price(entity.input.hit)}`,
			submenu: (_v, done) => new ActionMenu(
				`价格 ${priceId}（${entity.name}）`,
				[
					{ label: "改输出价", detail: price(entity.output), run: () => { this.askPriceField(tui, theme, draft, priceId, "output", "输出价（¥/百万 token）", refreshStatus, done); } },
					{ label: "改未缓存输入价", detail: price(entity.input.miss), run: () => { this.askPriceField(tui, theme, draft, priceId, "input.miss", "未缓存输入价（¥/百万 token）", refreshStatus, done); } },
					{ label: "改缓存命中输入价", detail: price(entity.input.hit), run: () => { this.askPriceField(tui, theme, draft, priceId, "input.hit", "缓存命中输入价（¥/百万 token）", refreshStatus, done); } },
					{ label: "删除该价格", detail: "被规则引用时保存会被拒", run: () => { draft.deletePrice(priceId); refreshStatus(`已删除价格 ${priceId}（Ctrl+S 保存）`); done(undefined); } },
				],
				theme,
				() => done(undefined),
			),
		}));
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
		});
	}

	/** 管理面：日历注册表（每条日历可删除） */
	private buildCalendarRegistry(
		draft: PricingDraft,
		tui: DrawerTui,
		theme: DrawerTheme,
		setTitle: (text: string) => void,
		goBack: () => void,
	): SettingsList {
		const items: SettingItem[] = Object.entries(draft.snapshot().calendars).map(([calId, entry]) => ({
			id: calId,
			label: `${entry.name}`,
			currentValue: `${entry.dates.length} 天`,
			description: `${calId}：${entry.dates.slice(0, 6).join("、")}${entry.dates.length > 6 ? " …" : ""}`,
			submenu: (_v, done) => new ActionMenu(
				`日历 ${calId}（${entry.name}）`,
				[{
					label: "删除该日历",
					detail: "被规则引用时保存会被拒",
					run: () => { draft.deleteCalendar(calId); goBack(); done(undefined); },
				}],
				theme,
				() => done(undefined),
			),
		}));
		void setTitle;
		void tui;
		return new SettingsList(items, Math.min(items.length + 4, 12), getSettingsListTheme(), () => {}, goBack, { enableSearch: true });
	}

	/**
	 * 文本输入统一入口：走 ExtensionInputComponent 覆盖层。
	 * 无 overlay 能力（单测/降级）时直接同步调用 onSubmit，便于断言。
	 */
	private askText(
		tui: DrawerTui,
		title: string,
		placeholder: string,
		onSubmit: (value: string) => void,
	): void {
		const input = new ExtensionInputComponent(title, placeholder, onSubmit, () => {}, { tui: tui as never });
		if (typeof tui.showOverlay !== "function") {
			// 降级：无法弹层，交由调用方决定（这里不阻塞流程）
			return;
		}
		tui.showOverlay(input, { width: 64, anchor: "center" });
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
