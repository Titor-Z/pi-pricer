/**
 * 轻量动作菜单 ActionMenu。
 *
 * 为什么自绘：pi-tui 的 SettingsList 对"无 submenu / 无 values"的普通项，按 Enter 是**空操作**，
 * 不能用来触发动作。此处自绘一个"列表 + Enter 执行 + Esc 返回"的最小菜单。
 *
 * 呈现模型：
 * - 条目支持函数形式（每次渲染重新求值），动作改完数据后无需手动刷新页面。
 * - 行内容用「单元格(cell) + 行内片段(span)」描述，便于做列对齐与局部语义着色。
 * - 非选中行：只按 span 的语义色着色，默认色 = muted（与底栏同档的灰）。
 * - 选中行：**忽略 span 颜色**，整行套 accent + selectedBg 背景，形成交互高亮。
 *   注意必须先拼纯文本再上色，否则 span 内部的重置码会提前终止背景色。
 */

import { matchesKey, type Component } from "@earendil-works/pi-tui";
import type { UiTheme } from "./pricing-prompt.ts";

/** 非选中行的默认文字色（与底栏一致的灰） */
const DEFAULT_ROW_COLOR = "muted";

/** 选中行背景语义色 */
const SELECTED_BG = "selectedBg";

/** 次行说明的语义色 */
const DETAIL_COLOR = "dim";

/** 行内着色片段（纯文本 + 语义色） */
export interface MenuSpan {
	/** 片段文本（纯文本，不含 ANSI） */
	text: () => string;
	/** 语义色名；缺省用行默认色 */
	color?: string;
}

/** 列表单元格：一组片段，可参与列对齐 */
export interface MenuCell {
	/** 单元格内的片段列表 */
	spans: () => MenuSpan[];
	/** true = 参与列对齐（右侧补空格到本列最大宽度） */
	align?: boolean;
}

/** 菜单项 */
export interface MenuEntry {
	/** 稳定 id */
	id: string;
	/** 主标签（单列不对齐时使用；与 cells 二选一，cells 优先） */
	label?: string | (() => string);
	/** 多列对齐行（优先于 label） */
	cells?: () => MenuCell[];
	/** 次行说明（可选） */
	detail?: string | (() => string);
	/** Enter 执行 */
	run: () => void;
}

/** 已求值的一行（纯文本片段 + 对齐标记） */
interface ResolvedRow {
	/** 各单元格：片段数组 + 是否参与列对齐 */
	cells: Array<{ parts: Array<{ text: string; color: string }>; align: boolean }>;
	/** 整行纯文本（用于「＋」判断与选中行上色） */
	plain: string;
}

/** 动作菜单组件 */
export class ActionMenu implements Component {
	/** 当前光标行 */
	private cursor = 0;

	constructor(
		private readonly theme: UiTheme,
		private readonly titleSource: string | (() => string),
		private readonly entriesSource: MenuEntry[] | (() => MenuEntry[]),
		private readonly onBack: () => void,
		private readonly hints = "↑↓ 移动 · Enter 执行 · Esc 返回",
		private readonly pageSize = 0,
		/** true = 卡片式：条目标题一行 + `→ 摘要` 一行，条目之间空行 */
		private readonly cards = false,
	) {}

	/** 本页在面包屑中的名字（末级标题，由抽屉渲染） */
	title(): string {
		return this.resolve(this.titleSource);
	}

	/** 底部键位提示（由抽屉统一渲染）；分页时自动追加翻页键 */
	footerHints(): string {
		const rows = this.entries().map((entry) => this.resolveRow(entry));
		const paged = this.pageSize > 0 && this.pinnedStart(rows) > this.pageSize;
		return paged ? `${this.hints} · PgUp/PgDn 翻页` : this.hints;
	}

	/** 取当前条目（支持函数形式：增删后自动反映） */
	private entries(): MenuEntry[] {
		return typeof this.entriesSource === "function" ? this.entriesSource() : this.entriesSource;
	}

	/** 求值标签（兼容函数形式） */
	private resolve(value: string | (() => string) | undefined): string {
		if (value === undefined) return "";
		return typeof value === "function" ? value() : value;
	}

	/** 把一条目求值成纯文本行（cells 优先，否则退回单列 label） */
	private resolveRow(entry: MenuEntry): ResolvedRow {
		const fallback: MenuCell = { spans: () => [{ text: () => this.resolve(entry.label) }] };
		const cells = entry.cells?.() ?? [fallback];
		const resolved = cells.map((cell) => ({
			align: cell.align === true,
			parts: cell.spans().map((span) => ({ text: span.text(), color: span.color ?? DEFAULT_ROW_COLOR })),
		}));
		const plain = resolved.map((cell) => cell.parts.map((part) => part.text).join("")).join("  ");
		return { cells: resolved, plain };
	}

	/** 各对齐列的最大宽度（按单元格索引） */
	private columnWidths(rows: ResolvedRow[]): number[] {
		const widths: number[] = [];
		for (const row of rows) {
			row.cells.forEach((cell, index) => {
				if (cell.align !== true) return;
				const length = cell.parts.map((part) => part.text).join("").length;
				widths[index] = Math.max(widths[index] ?? 0, length);
			});
		}
		return widths;
	}

	/**
	 * 渲染一行：选中 → 整行主题色 + 背景；否则按片段语义色。
	 * 两种模式都先按列补空，保证上下移动光标时列不跳动。
	 */
	private renderRow(row: ResolvedRow, widths: number[], selected: boolean): string {
		const columns = row.cells.map((cell, index) => {
			const plainText = cell.parts.map((part) => part.text).join("");
			const pad = cell.align === true ? Math.max(0, (widths[index] ?? 0) - plainText.length) : 0;
			const suffix = " ".repeat(pad);
			if (selected) return plainText + suffix;
			return cell.parts.map((part) => this.theme.fg(part.color, part.text)).join("") + suffix;
		});
		const line = columns.join("  ");
		if (selected === false) return line;
		const highlighted = this.theme.fg("accent", this.theme.bold(line));
		return this.theme.bg?.(SELECTED_BG, highlighted) ?? highlighted;
	}

	/** 尾部连续以「＋」开头的条目视为固定动作条（不参与分页，始终渲染） */
	private pinnedStart(rows: ResolvedRow[]): number {
		let cut = rows.length;
		while (cut > 0 && rows[cut - 1].plain.startsWith("＋")) cut -= 1;
		return cut;
	}

	render(_width: number): string[] {
		const entries = this.entries();
		const rows = entries.map((entry) => this.resolveRow(entry));
		const widths = this.columnWidths(rows);
		const pinnedStart = this.pinnedStart(rows);
		this.cursor = Math.min(this.cursor, Math.max(0, entries.length - 1));
		// 分页只作用于普通条目；「＋」动作条固定在列表末尾
		const size = this.pageSize > 0 ? this.pageSize : Math.max(1, pinnedStart);
		const pageCount = Math.max(1, Math.ceil(pinnedStart / size));
		// 光标停在动作条上时，仍展示最后一页
		const cursorItem = Math.min(this.cursor, Math.max(0, pinnedStart - 1));
		const page = Math.min(Math.floor(cursorItem / size), pageCount - 1);
		const start = page * size;
		const end = Math.min(pinnedStart, start + size);
		const lines: string[] = [];
		let first = true;
		const pushEntry = (index: number): void => {
			const selected = index === this.cursor;
			const prefix = selected ? "▶ " : "  ";
			if (this.cards) {
				// 卡片式：条目标题一行 + `→ 摘要` 一行，条目之间空行
				if (!first) lines.push("");
				lines.push(`${prefix}${this.renderRow(rows[index], widths, selected)}`);
				const summary = this.resolve(entries[index].detail);
				if (summary) lines.push(`  ${this.theme.fg(DETAIL_COLOR, `→ ${summary}`)}`);
				first = false;
				return;
			}
			lines.push(`${prefix}${this.renderRow(rows[index], widths, selected)}`);
			const detail = this.resolve(entries[index].detail);
			if (detail) lines.push(`    ${this.theme.fg(DETAIL_COLOR, detail)}`);
			first = false;
		};
		for (let index = start; index < end; index += 1) pushEntry(index);
		// 分页统计放列表下方（不再占用面包屑位置）
		if (pageCount > 1) lines.push("", `  ${this.theme.fg(DETAIL_COLOR, `第 ${page + 1}/${pageCount} 页`)}`);
		// 固定动作条（「＋」）放在分页下面：行式布局下与上方分区
		if (pinnedStart < entries.length) {
			if (!first && !this.cards) lines.push("");
			for (let index = pinnedStart; index < entries.length; index += 1) pushEntry(index);
		}
		return lines;
	}

	handleInput(data: string): void {
		const entries = this.entries();
		const rows = entries.map((entry) => this.resolveRow(entry));
		const itemCount = this.pinnedStart(rows);
		const lastItem = Math.max(0, itemCount - 1);
		const last = Math.max(0, entries.length - 1);
		const size = this.pageSize > 0 ? this.pageSize : Math.max(1, itemCount);
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.onBack();
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.cursor = Math.min(last, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.cursor = Math.max(0, Math.min(this.cursor, lastItem) - size);
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.cursor = Math.min(lastItem, this.cursor + size);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			entries[this.cursor]?.run();
		}
	}

	invalidate(): void {
		// 无内部缓存（标签函数每次渲染求值）
	}
}
