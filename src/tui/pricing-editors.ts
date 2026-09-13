/**
 * 三个就地编辑器：星期多选 / 时段列表 / 日期列表。
 *
 * 均为自绘轻量组件（SettingsList 的普通项 Enter 不触发 onChange，不适合"切换/删除"语义）。
 * 新增条目需要输入框 → 由调用方（抽屉）收到 onAddRequested 后压入输入子页，
 * 编辑器本身不持有输入页生命周期。
 */

import { matchesKey, type Component } from "@earendil-works/pi-tui";
import type { UiTheme } from "./pricing-prompt.ts";

/** 星期中文名（1=周一 … 7=周日） */
const WEEKDAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

/** 星期多选编辑器：Enter 切换（即时生效），Esc 返回 */
export class WeekdaysEditor implements Component {
	/** 当前光标所在行 */
	private cursor = 0;

	constructor(
		private readonly theme: UiTheme,
		selected: number[],
		private readonly onChange: (next: number[]) => void,
		private readonly onDone: () => void,
	) {
		this.selected = new Set(selected);
	}

	/** 已选星期集合 */
	private readonly selected: Set<number>;

	/** 本页在面包屑中的名字（由抽屉渲染） */
	title(): string {
		return "编辑星期";
	}

	/** 底部键位提示 */
	footerHints(): string {
		return "↑↓ 移动 · Enter 切换 · Esc 返回";
	}

	render(_width: number): string[] {
		const lines: string[] = [];
		for (let day = 1; day <= 7; day += 1) {
			const mark = this.selected.has(day) ? "◉" : "◌";
			const prefix = day - 1 === this.cursor ? "▶ " : "  ";
			lines.push(`${prefix}${mark} ${WEEKDAY_NAMES[day - 1]}`);
		}
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.onDone();
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.cursor = Math.min(6, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			const day = this.cursor + 1;
			// 即时生效（与其他页 Enter 写事务一致，Esc 只负责返回）
			if (this.selected.has(day)) this.selected.delete(day);
			else this.selected.add(day);
			this.onChange([...this.selected].sort((a, b) => a - b));
		}
	}

	invalidate(): void {
		// 无内部缓存
	}
}

/** 条目列表编辑器（时段 / 日期通用）：Enter 删除选中项，末尾「＋添加」触发回调 */
export class ItemListEditor implements Component {
	/** 当前光标行（0..items.length，最后一行是"添加"） */
	private cursor = 0;

	constructor(
		private readonly theme: UiTheme,
		private readonly titleSource: string,
		private items: string[],
		private readonly addHint: string,
		private readonly onAddRequested: () => void,
		private readonly onRemove: (index: number) => void,
		private readonly onDone: () => void,
	) {}

	/** 用新条目重建（抽屉输入子页提交成功后调用） */
	setItems(items: string[]): void {
		this.items = items;
		this.cursor = Math.min(this.cursor, items.length);
	}

	/** 当前是否停在“添加”行 */
	isOnAddRow(): boolean {
		return this.cursor === this.items.length;
	}

	/** 本页在面包屑中的名字（由抽屉渲染） */
	title(): string {
		return this.titleSource;
	}

	/** 底部键位提示 */
	footerHints(): string {
		return "↑↓ 移动 · Enter 删除 / 添加 · Esc 返回";
	}

	render(_width: number): string[] {
		const lines: string[] = [];
		if (this.items.length === 0) lines.push(`  ${this.theme.fg("dim", "（空）")}`);
		this.items.forEach((item, index) => {
			const prefix = index === this.cursor ? "▶ " : "  ";
			lines.push(`${prefix}${item}`);
		});
		const addPrefix = this.cursor === this.items.length ? "▶ " : "  ";
		lines.push(`${addPrefix}${this.theme.fg("accent", `＋${this.addHint}`)}`);
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.onDone();
			return;
		}
		if (matchesKey(data, "up")) {
			this.cursor = Math.max(0, this.cursor - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.cursor = Math.min(this.items.length, this.cursor + 1);
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			if (this.isOnAddRow()) {
				this.onAddRequested();
				return;
			}
			// 删除选中项；删除后光标回退到合法范围
			this.onRemove(this.cursor);
			this.cursor = Math.max(0, Math.min(this.cursor, this.items.length - 1));
		}
	}

	invalidate(): void {
		// 无内部缓存
	}
}
