/**
 * 输入弹窗（PromptOverlay）：pi-pricer 自建文本输入覆盖层。
 *
 * 为什么自建而不是用 pi-coding-agent 的 ExtensionInputComponent：
 * - 它的 placeholder 参数被丢弃（占位提示从不出现在编辑框中）
 * - 它没有"帮助脚注"插槽 —— 每个输入场景都需要一行「注：…」说明输入格式
 * - 它没有内联校验 —— 格式错误只能走"关掉再开一个错误弹窗"的尴尬循环
 *
 * 布局（自上而下）：
 *   边框 → 空行 → 标题 → 空行 → 输入框 → [校验错误行，error 色] → 空行
 *   → 「注：」帮助脚注（dim）→ 空行 → 键位提示 → 空行 → 边框
 *
 * 校验时机：提交时（Enter）。失败弹窗不关闭、输入不丢失，错误行紧贴输入框；
 * 任意后续输入或 Esc 自动清除错误行。
 */
import { Container, getKeybindings, Input, Spacer, Text } from "@earendil-works/pi-tui";
import { DynamicBorder, keyHint } from "@earendil-works/pi-coding-agent";
import type { DrawerTheme } from "./pricing-info-page.ts";

/** 输入弹窗选项：title 必填，其余可选 */
export interface PromptOptions {
	title: string;
	/** 帮助脚注（渲染为 dim 色的"注：…"行） */
	notes?: string[];
	/** 占位提示（输入为空时显示，不参与值） */
	placeholder?: string;
	/** 预填当前值（改名/改值场景复用旧值） */
	initialValue?: string;
	/** 提交时校验：返回错误文案则弹窗内展示并保持打开；返回 null 通过 */
	validate?: (value: string) => string | null;
	onSubmit: (value: string) => void;
	onCancel?: () => void;
}

/**
 * 覆盖层输入框：标题 + 预填输入 + 内联校验 + 帮助脚注 + 键位提示。
 * Enter 提交（校验失败时弹窗内显示错误，不关闭、不丢输入）；Esc 走 onCancel。
 */
export class PromptOverlay extends Container {
	private readonly input: Input;
	/** 当前校验错误（null = 无）；非空时在输入框下方以 error 色渲染 */
	private error: string | null = null;
	/** 输入框与键位提示之间的动态区：错误行 + 空行 + 注脚（随状态重排） */
	private readonly dynamic = new Container();
	/** Focusable 转发给 Input（IME 光标定位，与 pi-coding-agent 行为一致） */
	private _focused = false;

	constructor(private readonly options: PromptOptions, private readonly theme: DrawerTheme) {
		super();
		const { title, notes, placeholder, initialValue } = options;
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		this.input = new Input({ placeholder: placeholder ?? "" });
		if (initialValue) this.input.setValue(initialValue);
		this.addChild(this.input);
		this.addChild(this.dynamic);
		this.addChild(new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.rebuildDynamic();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** 无定时器等后台资源；保留此方法是为了与覆盖层 handle 的生命周期契约对齐 */
	dispose(): void {}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.confirm") || data === "\n") {
			const value = this.input.getValue();
			const err = this.options.validate?.(value) ?? null;
			if (err !== null) {
				this.showError(err);
				return;
			}
			this.clearError();
			this.options.onSubmit(value);
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.clearError();
			this.options.onCancel?.();
			return;
		}
		this.clearError();
		this.input.handleInput(data);
	}

	/** 展示校验错误（error 色，紧贴输入框）并触发重绘 */
	private showError(message: string): void {
		this.error = message;
		this.rebuildDynamic();
		this.invalidate();
	}

	/** 清除校验错误（提交成功 / 任意输入 / Esc 时调用） */
	private clearError(): void {
		if (this.error === null) return;
		this.error = null;
		this.rebuildDynamic();
		this.invalidate();
	}

	/** 重建输入框与键位提示之间的动态区：错误行 + 空行 + 注脚 */
	private rebuildDynamic(): void {
		this.dynamic.clear();
		if (this.error !== null) {
			this.dynamic.addChild(new Text(this.theme.fg("error", `  ✗ ${this.error}`), 1, 0));
		}
		this.dynamic.addChild(new Text("", 1, 0));
		(this.options.notes ?? []).forEach((note) => {
			this.dynamic.addChild(new Text(this.theme.fg("dim", `  注：${note}`), 1, 0));
		});
	}
}