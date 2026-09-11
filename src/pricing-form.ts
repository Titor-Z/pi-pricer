/**
 * 可复用表单组件库：规则字段编辑页（星期/时段/当天历/价格/有效期）与配套编辑器。
 * 组件自管内部状态，修改 draft 后通过 getContainerRef 触发外层容器重绘，
 * 字段值每次重建时从 draft.snapshot() 读取，保证编辑后实时可见。
 */

import { getKeybindings, Input, type Component } from "@earendil-works/pi-tui";
import type { DrawerTheme } from "./pricing-info-page.ts";
import type { PricingDraft } from "./pricing-draft.ts";
import { isValidCalendarDate, parsePriceInput, price, rangesCn, weekdaysCn } from "./pricing-desc.ts";

// ── 文本输入请求（由字段页向 drawer 的 askText 转发） ─────────────────────

export interface TextPromptRequest {
	title: string;
	placeholder: string;
	/** 帮助脚注（PromptOverlay 中渲染为 dim 的"注：…"行） */
	notes?: string[];
	/** 预填当前值 */
	initialValue?: string;
	/** 提交时校验：返回错误文案则弹窗内展示并保持打开；返回 null 通过 */
	validate?: (value: string) => string | null;
	onSubmit: (value: string) => void;
}

// ── 星期编辑器：Enter 切换 ◉/◌，Esc 提交当前集合 ─────────────────────────

export function buildWeekdaysEditor(
	current: number[],
	theme: DrawerTheme,
	onDone: (result: number[]) => void,
	getContainerRef?: () => Component,
): Component {
	const labels = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
	const selected = new Set(current);
	let cursor = 0;

	return {
		invalidate() {},
		render(width: number): string[] {
			const lines: string[] = [`  ${theme.bold("生效星期")}`, ""];
			labels.forEach((label, i) => {
				const c = i === cursor ? "→ " : "  ";
				const m = selected.has(i + 1) ? "◉ " : "◌ ";
				lines.push(`${c}${m}${i === 6 ? "周日（空=每天）" : label}`.slice(0, width));
			});
			lines.push("");
			lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 切换 · Esc 保存返回"));
			return lines;
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.up")) {
				cursor = (cursor - 1 + labels.length) % labels.length;
			} else if (kb.matches(data, "tui.select.down")) {
				cursor = (cursor + 1) % labels.length;
			} else if (kb.matches(data, "tui.select.confirm")) {
				const dayNum = cursor + 1;
				if (selected.has(dayNum)) selected.delete(dayNum);
				else selected.add(dayNum);
				getContainerRef?.().invalidate?.();
			} else if (kb.matches(data, "tui.select.cancel")) {
				onDone([...selected].sort((a, b) => a - b));
			}
		},
	};
}

// ── 时段/日期编辑器：动作列表（移除… / ＋ 添加），Esc 保存返回 ─────────────

type EditorAction = { label: string; run: () => void };

function buildActionList(
	title: string,
	labelOf: (value: string) => string,
	current: string[],
	placeholder: string,
	theme: DrawerTheme,
	askText: (req: TextPromptRequest) => void,
	onCommit: (result: string[]) => void,
	onAdd: (value: string, valueList: string[]) => void,
	parseRaw: (raw: string) => string | null,
	notes: string[],
	formatError: string,
	getContainerRef?: () => Component,
): Component {
	const values = [...current];
	let cursor = 0;
	let actions: EditorAction[] = [];

	const build = (): void => {
		const next: EditorAction[] = values.map((v, i) => ({
			label: `移除 ${labelOf(v)}`,
			run: () => {
				values.splice(i, 1);
				cursor = Math.max(0, cursor - 1);
				build();
				onCommit([...values]);
				getContainerRef?.().invalidate?.();
			},
		}));
		next.push({
			label: "＋ 添加",
			run: () => {
				askText({
					title,
					placeholder,
					notes,
					validate(raw): string | null {
						const parsed = parseRaw(raw.trim());
						if (!parsed) return formatError;
						if (values.includes(parsed)) return `已存在：${parsed}`;
						return null;
					},
					onSubmit(raw) {
						const parsed = parseRaw(raw.trim());
						if (!parsed) return; // 防御：validate 已把关，合法才落值
						onAdd(parsed, values);
						build();
						getContainerRef?.().invalidate?.();
					},
				});
			},
		});
		actions = next;
	};
	build();

	return {
		invalidate() {},
		render(width: number): string[] {
			const lines: string[] = [`  ${theme.bold(title)}`, ""];
			if (values.length === 0) lines.push("  （空列表）");
			actions.forEach((a, i) => {
				const c = i === cursor ? "→ " : "  ";
				lines.push(`${c}${a.label}`.slice(0, width));
			});
			lines.push("");
			lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 操作 · Esc 保存返回"));
			return lines;
		},
		handleInput(data: string): void {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.up")) {
				cursor = (cursor - 1 + Math.max(1, actions.length)) % Math.max(1, actions.length);
			} else if (kb.matches(data, "tui.select.down")) {
				cursor = (cursor + 1) % Math.max(1, actions.length);
			} else if (kb.matches(data, "tui.select.confirm")) {
				if (cursor < actions.length) {
					build();
					actions[cursor]?.run();
				}
			} else if (kb.matches(data, "tui.select.cancel")) {
				onCommit(values);
			}
		},
	};
}

/** 时段编辑器：值形如 "09:00-12:00" */
export function buildRangesEditor(
	current: [string, string][],
	theme: DrawerTheme,
	askText: (req: TextPromptRequest) => void,
	onCommit: (result: [string, string][]) => void,
	getContainerRef?: () => Component,
): Component {
	const values: string[] = current.map(([s, e]) => `${s}-${e}`);
	return buildActionList(
		"生效时段",
		(v) => v,
		values,
		"09:00-12:00",
		theme,
		askText,
		(result) => onCommit(result.map((v) => v.split("-") as [string, string])),
		(v, list) => {
			list.push(v);
			getContainerRef?.().invalidate?.();
		},
		(raw) => {
			const m = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(raw);
			return m ? `${m[1]}-${m[2]}` : null;
		},
		["格式：HH:MM-HH:MM，如 09:00-12:00（半开区间，结束不包含）"],
		"格式不对（示例 09:00-12:00，结束不包含）",
		getContainerRef,
	);
}

/** 日期编辑器：MM-DD ｜ YYYY-MM-DD */
export function buildDatesEditor(
	current: string[],
	theme: DrawerTheme,
	askText: (req: TextPromptRequest) => void,
	onCommit: (result: string[]) => void,
	getContainerRef?: () => Component,
): Component {
	return buildActionList(
		"日期列表（MM-DD 每年循环 | YYYY-MM-DD 精确）",
		(v) => v,
		current,
		"MM-DD",
		theme,
		askText,
		onCommit,
		(v, list) => {
			list.push(v);
			getContainerRef?.().invalidate?.();
		},
		(raw) => (isValidCalendarDate(raw) ? raw : null),
		["MM-DD 每年循环；YYYY-MM-DD 精确一次"],
		"日期不合法或不存在（月份 01-12，日期按当月上限）",
		getContainerRef,
	);
}

// ── RuleFormPage：单条规则的字段编辑页 ────────────────────────────────────

export interface RuleFormConfig {
	draft: PricingDraft;
	planId: string;
	ruleIndex: number;
	theme: DrawerTheme;
	askText: (req: TextPromptRequest) => void;
	onDone: () => void;
	/** 触发外层容器重绘（字段值编辑后实时刷新） */
	getContainerRef?: () => Component;
}

type EditorBody = { render: (w: number) => string[]; handleInput?: (d: string) => void };

export class RuleFormPage implements Component {
	private rows: Array<{ label: string; detail: string; run: () => void }> = [];
	private selected = 0;
	private activeEditor?: EditorBody;

	constructor(private readonly config: RuleFormConfig) {
		this.rebuildRows();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.activeEditor) return this.activeEditor.render(width);
		const { theme } = this.config;
		const lines: string[] = [`  ${theme.bold("规则字段")}`, ""];
		this.rows.forEach((row, i) => {
			const c = i === this.selected ? "→ " : "  ";
			lines.push(`${c}${row.label}  ${theme.fg("dim", row.detail)}`.slice(0, width));
		});
		lines.push("");
		lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 编辑 · Esc 返回"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.activeEditor) {
			this.activeEditor.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + this.rows.length) % this.rows.length;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.rows.length;
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.rows[this.selected]?.run();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.config.onDone();
		}
	}

	/** 退出子编辑器并重建字段行（值实时来自 draft.snapshot()） */
	private closeEditor(cb?: () => void): void {
		this.activeEditor = undefined;
		this.rebuildRows();
		this.config.getContainerRef?.().invalidate?.();
		cb?.();
	}

	private rebuildRows(): void {
		const { draft, planId, ruleIndex, theme, askText, getContainerRef } = this.config;
		const snap = draft.snapshot();
		const rule = snap.plans[planId]?.rules[ruleIndex];
		if (!rule) {
			this.rows = [{ label: "规则不存在", detail: "", run: () => {} }];
			return;
		}
		const s = rule.schedule;

		this.rows = [
			{
				label: "生效星期",
				detail: s.weekdays.length === 0 ? "每天" : weekdaysCn(s.weekdays),
				run: () => {
					this.activeEditor = buildWeekdaysEditor(s.weekdays, theme, (result) => {
						draft.setScheduleWeekdays(planId, ruleIndex, result);
						this.closeEditor();
					}, getContainerRef);
				},
			},
			{
				label: "生效时段",
				detail: s.ranges.length === 0 ? "全天" : rangesCn(s.ranges),
				run: () => {
					this.activeEditor = buildRangesEditor(s.ranges, theme, askText, (result) => {
						draft.setScheduleRanges(planId, ruleIndex, result);
						this.closeEditor();
					}, getContainerRef);
				},
			},
			{
				label: "日历",
				detail: s.calendar
					? `${s.calendarMode === "include" ? "仅" : "除"} ${snap.calendars[s.calendar]?.name ?? s.calendar}`
					: "（无）",
				run: () => {
					if (Object.keys(snap.calendars).length === 0) {
						askText({ title: "尚未创建日历，请先通过 /price calendar 新建", placeholder: "", onSubmit() {} });
						return;
					}
					this.activeEditor = this.buildCalendarEditor();
				},
			},
			{
				label: "指定日期",
				detail: (s.includeDates?.length ?? 0) === 0 ? "（无）" : (s.includeDates ?? []).join("、"),
				run: () => {
					this.activeEditor = buildDatesEditor(s.includeDates ?? [], theme, askText, (result) => {
						draft.setScheduleIncludeDates(planId, ruleIndex, result);
						this.closeEditor();
					}, getContainerRef);
				},
			},
			{
				label: "排除日期",
				detail: (s.excludeDates?.length ?? 0) === 0 ? "（无）" : (s.excludeDates ?? []).join("、"),
				run: () => {
					this.activeEditor = buildDatesEditor(s.excludeDates ?? [], theme, askText, (result) => {
						draft.setScheduleExcludeDates(planId, ruleIndex, result);
						this.closeEditor();
					}, getContainerRef);
				},
			},
			{
				label: "价格",
				detail: `${snap.prices[rule.price]?.name ?? rule.price}  ${price(snap.prices[rule.price]?.output ?? 0)}`,
				run: () => {
					this.activeEditor = this.buildPriceEditor();
				},
			},
			{
				label: "有效期",
				detail: rule.validUntil ?? "无限制",
				run: () => {
					askText({
						title: "规则截止日期（YYYY-MM-DD，留空清除）",
						placeholder: "YYYY-MM-DD",
						notes: ["留空表示无截止日期，规则始终生效"],
						validate: (value) => {
							const raw = value.trim();
							if (raw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
								return `日期格式不对：${raw}（需 YYYY-MM-DD）`;
							}
							return null;
						},
						onSubmit: (value) => {
							draft.setRuleValidUntil(planId, ruleIndex, value.trim());
							this.closeEditor();
						},
					});
				},
			},
			{
				label: "删除该规则",
				detail: draft.snapshot().plans[planId]?.rules.length === 1 ? "方案至少保留一条规则（禁用）" : "最近一条规则不可删除",
				run: () => {
					this.activeEditor = this.buildDeleteRuleEditor();
				},
			},
		];
	}

	/** 删除规则确认（方案至少保留一条） */
	private buildDeleteRuleEditor(): EditorBody {
		const { draft, planId, ruleIndex, theme, getContainerRef } = this.config;
		const me = this;
		let cursor = 0;
		const rulesCount = draft.snapshot().plans[planId]?.rules.length ?? 0;
		const actions: Array<{ label: string; run: () => void }> = rulesCount > 1
			? [
					{ label: "确认删除该规则", run: () => { draft.removeRule(planId, ruleIndex); this.closeEditor(this.config.onDone); } },
				]
			: [{ label: "无法删除（方案至少保留一条规则）", run: () => this.closeEditor() }];

		return {
			render(width: number): string[] {
				const lines: string[] = [`  ${theme.bold("删除规则")}`, ""];
				actions.forEach((a, i) => {
					const c = i === cursor ? "→ " : "  ";
					lines.push(`${c}${a.label}`.slice(0, width));
				});
				lines.push("");
				lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 确认 · Esc 返回"));
				return lines;
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.up")) {
					cursor = (cursor - 1 + actions.length) % actions.length;
				} else if (kb.matches(data, "tui.select.down")) {
					cursor = (cursor + 1) % actions.length;
				} else if (kb.matches(data, "tui.select.confirm")) {
					actions[cursor]?.run();
				} else if (kb.matches(data, "tui.select.cancel")) {
					me.closeEditor();
				}
				getContainerRef?.().invalidate?.();
			},
		};
	}

	/** 日历选择器：仅 / 除 / 清除 */
	private buildCalendarEditor(): EditorBody {
		const { draft, planId, ruleIndex, theme, getContainerRef } = this.config;
		const me = this;
		const s = draft.snapshot().plans[planId]?.rules[ruleIndex]?.schedule;
		const calIds = Object.keys(draft.snapshot().calendars);
		let cursor = 0;
		const labelOf = (calId: string): string => draft.snapshot().calendars[calId]?.name ?? calId;

		const actions: Array<{ label: string; run: () => void }> = [];
		for (const calId of calIds) {
			actions.push({ label: `仅 ${labelOf(calId)}（只在这些日期生效）`, run: () => { draft.setScheduleCalendar(planId, ruleIndex, calId, "include"); this.closeEditor(); } });
		}
		for (const calId of calIds) {
			actions.push({ label: `除 ${labelOf(calId)}（跳过这些日期）`, run: () => { draft.setScheduleCalendar(planId, ruleIndex, calId, "exclude"); this.closeEditor(); } });
		}
		actions.push({ label: "清除（不引用日历）", run: () => { draft.setScheduleCalendar(planId, ruleIndex, undefined, undefined); this.closeEditor(); } });

		return {
			render(width: number): string[] {
				const lines: string[] = [`  ${theme.bold("日历")}`, ""];
				if (s?.calendar) lines.push(`  当前：${s.calendarMode === "include" ? "仅" : "除"} ${s.calendar}`);
				actions.forEach((a, i) => {
					const c = i === cursor ? "→ " : "  ";
					lines.push(`${c}${a.label}`.slice(0, width));
				});
				lines.push("");
				lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 确认 · Esc 返回"));
				return lines;
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.up")) {
					cursor = (cursor - 1 + Math.max(1, actions.length)) % Math.max(1, actions.length);
				} else if (kb.matches(data, "tui.select.down")) {
					cursor = (cursor + 1) % Math.max(1, actions.length);
				} else if (kb.matches(data, "tui.select.confirm")) {
					actions[cursor]?.run();
				} else if (kb.matches(data, "tui.select.cancel")) {
					me.closeEditor();
				}
				getContainerRef?.().invalidate?.();
			},
		};
	}

	/** 价格选择器：列出所有价格实体 */
	private buildPriceEditor(): EditorBody {
		const { draft, planId, ruleIndex, theme, getContainerRef } = this.config;
		const me = this;
		const snap = draft.snapshot();
		const current = snap.plans[planId]?.rules[ruleIndex]?.price;
		let cursor = 0;
		const items = Object.entries(snap.prices).map(([priceId, p]) => ({
			label: `${priceId === current ? "◉ " : "  "}${p.name}  ${price(p.output)}`,
			run: () => {
				draft.setRulePrice(planId, ruleIndex, priceId);
				this.closeEditor();
			},
		}));

		return {
			render(width: number): string[] {
				const lines: string[] = [`  ${theme.bold("价格")}`, ""];
				items.forEach((a, i) => {
					const c = i === cursor ? "→ " : "  ";
					lines.push(`${c}${a.label}`.slice(0, width));
				});
				lines.push("");
				lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 确认 · Esc 返回"));
				return lines;
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.up")) {
					cursor = (cursor - 1 + Math.max(1, items.length)) % Math.max(1, items.length);
				} else if (kb.matches(data, "tui.select.down")) {
					cursor = (cursor + 1) % Math.max(1, items.length);
				} else if (kb.matches(data, "tui.select.confirm")) {
					items[cursor]?.run();
				} else if (kb.matches(data, "tui.select.cancel")) {
					me.closeEditor();
				}
				getContainerRef?.().invalidate?.();
			},
		};
	}
}

// ── PriceFormPage：单个价格实体的字段编辑页（输出/输入/改名/删除） ────────────

export interface PriceFormConfig {
	draft: PricingDraft;
	priceId: string;
	theme: DrawerTheme;
	/** 提示信息（转发到抽屉状态栏） */
	refreshStatus: (msg?: string) => void;
	onDone: () => void;
	/** 触发外层容器重绘（字段值编辑后实时刷新） */
	getContainerRef?: () => Component;
}

/**
 * 价格字段编辑页：与 RuleFormPage 同构的"字段列表 + 子编辑器"模式。
 * 每个字段 Enter 后打开 pi-tui Input（预填当前值，Enter 提交 / Esc 取消），
 * 不再使用 overlay 弹窗 —— 同一页内就地编辑，Esc 每层只退一级。
 */
export class PriceFormPage implements Component {
	private rows: Array<{ label: string; detail: string; run: () => void }> = [];
	private selected = 0;
	private activeEditor?: EditorBody;

	constructor(private readonly config: PriceFormConfig) {
		this.rebuildRows();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.activeEditor) return this.activeEditor.render(width);
		const { theme } = this.config;
		const lines: string[] = [`  ${theme.bold("价格字段")}`, ""];
		this.rows.forEach((row, i) => {
			const c = i === this.selected ? "→ " : "  ";
			lines.push(`${c}${row.label}  ${theme.fg("dim", row.detail)}`.slice(0, width));
		});
		lines.push("");
		lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 编辑 · Esc 返回"));
		return lines;
	}

	handleInput(data: string): void {
		if (this.activeEditor) {
			this.activeEditor.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.selected = (this.selected - 1 + this.rows.length) % this.rows.length;
		} else if (kb.matches(data, "tui.select.down")) {
			this.selected = (this.selected + 1) % this.rows.length;
		} else if (kb.matches(data, "tui.select.confirm")) {
			this.rows[this.selected]?.run();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.config.onDone();
		}
	}

	/** 退出子编辑器并重建字段行（值实时来自 draft.snapshot()） */
	private closeEditor(cb?: () => void): void {
		this.activeEditor = undefined;
		this.rebuildRows();
		this.config.getContainerRef?.().invalidate?.();
		cb?.();
	}

	/** 打开文本编辑器：pi-tui Input，预填当前值，Enter 提交 / Esc 取消；校验失败就地显示错误不关闭 */
	private openTextEditor(
		label: string,
		current: string,
		onCommit: (value: string) => void,
		opts: { notes?: string[]; validate?: (value: string) => string | null } = {},
	): void {
		const { theme, getContainerRef } = this.config;
		const input = new Input({ placeholder: "输入新值，Enter 提交 / Esc 取消" });
		input.setValue(current);
		/** 就地校验错误（提交失败时显示在输入框下方，再次输入自动清除） */
		let error: string | null = null;
		const commit = (value: string): void => {
			const err = opts.validate?.(value) ?? null;
			if (err !== null) {
				error = err;
				getContainerRef?.().invalidate?.();
				return;
			}
			this.closeEditor();
			onCommit(value);
		};
		input.onSubmit = (value) => { commit(value); };
		input.onEscape = () => { this.closeEditor(); };
		this.activeEditor = {
			render(width: number): string[] {
				const lines = [`  ${theme.bold(label)}`, ""];
				(opts.notes ?? []).forEach((n) => lines.push(theme.fg("dim", `  注：${n}`)));
				lines.push("", ...input.render(width));
				if (error !== null) lines.push(theme.fg("error", `  ✗ ${error}`));
				return lines;
			},
			handleInput(data: string): void {
				if (error !== null) {
					error = null;
					getContainerRef?.().invalidate?.();
				}
				input.handleInput(data);
			},
		};
	}

	private rebuildRows(): void {
		const { draft, priceId, theme, refreshStatus } = this.config;
		const snap = draft.snapshot();
		const entity = snap.prices[priceId];
		if (!entity) {
			this.rows = [{ label: "价格不存在（可能已删除）", detail: "", run: () => {} }];
			return;
		}

		/** 数值字段编辑器：校验通过后写入 draft（错误就地显示，不关闭编辑器） */
		const fieldOpen = (label: string, field: "input.miss" | "input.hit" | "output", current: () => number): void => {
			this.openTextEditor(label, String(current()), (value) => {
				const parsed = parsePriceInput(value) ?? 0;
				draft.setPriceField(priceId, field, parsed);
				refreshStatus(`${priceId} ${label} = ${price(parsed)}（Ctrl+S 保存）`);
			}, {
				notes: ["单位：¥ / 百万 token；可省略 ¥，如 ¥8 或 8"],
				validate: (value) => {
					if (parsePriceInput(value) === null) {
						return `无效价格：${value.trim() || "（空）"}（示例 ¥8 或 8）`;
					}
					return null;
				},
			});
		};

		this.rows = [
			{
				label: "输出价",
				detail: price(entity.output),
				run: () => fieldOpen("输出价（¥/百万 token）", "output", () => draft.snapshot().prices[priceId]?.output ?? 0),
			},
			{
				label: "未缓存输入价",
				detail: price(entity.input.miss),
				run: () => fieldOpen("未缓存输入价（¥/百万 token）", "input.miss", () => draft.snapshot().prices[priceId]?.input.miss ?? 0),
			},
			{
				label: "缓存命中输入价",
				detail: price(entity.input.hit),
				run: () => fieldOpen("缓存命中输入价（¥/百万 token）", "input.hit", () => draft.snapshot().prices[priceId]?.input.hit ?? 0),
			},
			{
				label: "重命名",
				detail: entity.name,
				run: () => this.openTextEditor("重命名（留空回退为 id）", entity.name, (value) => {
					draft.setPriceName(priceId, value);
					refreshStatus(`价格 ${priceId} 已改名（Ctrl+S 保存）`);
				}, { notes: ["留空则回退为 id"] }),
			},
			{
				label: "删除该价格",
				detail: "被规则引用时保存会被拒",
				run: () => { this.activeEditor = this.buildDeleteEditor(); },
			},
		];
	}

	/** 删除确认（与规则删除一致：确认后才真正从 draft 移除） */
	private buildDeleteEditor(): EditorBody {
		const { theme } = this.config;
		const me = this;
		let cursor = 0;
		const actions = [
			{ label: "确认删除该价格", run: () => { me.config.draft.deletePrice(me.config.priceId); me.closeEditor(me.config.onDone); } },
		];

		return {
			render(width: number): string[] {
				const lines: string[] = [`  ${theme.bold("删除价格")}`, ""];
				actions.forEach((a, i) => {
					const c = i === cursor ? "→ " : "  ";
					lines.push(`${c}${a.label}`.slice(0, width));
				});
				lines.push("");
				lines.push(theme.fg("dim", "  ↑↓ 选择 · Enter 确认 · Esc 返回"));
				return lines;
			},
			handleInput(data: string): void {
				const kb = getKeybindings();
				if (kb.matches(data, "tui.select.up")) {
					cursor = (cursor - 1 + actions.length) % actions.length;
				} else if (kb.matches(data, "tui.select.down")) {
					cursor = (cursor + 1) % actions.length;
				} else if (kb.matches(data, "tui.select.confirm")) {
					actions[cursor]?.run();
				} else if (kb.matches(data, "tui.select.cancel")) {
					me.closeEditor();
				}
			},
		};
	}
}