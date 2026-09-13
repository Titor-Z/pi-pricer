/**
 * 输入页 InputPage。
 *
 * 为什么不用弹窗：弹窗会顶掉面包屑，用户失去"我在第几层"的感知（规则面板里
 * 「时区 / 有效期 / 重命名」曾是弹窗，与「星期 / 时段」的进子页行为不一致）。
 * 现在所有输入都作为**子页压栈**：面包屑照常体现层级，抽屉帧规则不变。
 *
 * 布局：输入行 → 错误行（可选） → 「注：」脚注（可选）。
 * 契约：
 * - 边框、空行、键位提示都由抽屉统一渲染；本组件只画内容行。
 * - 「注：」前缀只在渲染层加，调用方只传正文。
 */

import { Input, matchesKey, type Component } from "@earendil-works/pi-tui";

/** 渲染所需的最小主题接口（pi Theme 结构兼容） */
export interface UiTheme {
	/** 语义色（accent / error / dim / muted / borderAccent / success / warning / text） */
	fg(color: string, text: string): string;
	/** 背景色（selectedBg 等）；可选，缺省时退化为不着背景 */
	bg?(color: string, text: string): string;
	/** 加粗 */
	bold(text: string): string;
}

/** 输入页配置 */
export interface InputPageOptions {
	/** 面包屑里的名字（动词 + 对象，如「编辑时区」） */
	title: string;
	/** 「注：」脚注正文（渲染层自动加前缀） */
	note?: string;
	/** 占位提示 */
	placeholder?: string;
	/** 初始值（就地编辑时预填现值） */
	initialValue?: string;
	/** 提交时校验：返回错误文案则拦截（不离开本页、不丢输入） */
	validate?: (value: string) => string | null;
	/** 校验通过后提交 */
	onSubmit: (value: string) => void;
	/** Esc 取消（返回上一层） */
	onCancel: () => void;
}

/** 单行输入页组件 */
export class InputPage implements Component {
	/** 内部输入框（负责编辑与光标） */
	private readonly input: Input;

	/** 当前错误文案（null = 无错误） */
	private error: string | null = null;

	constructor(
		private readonly theme: UiTheme,
		private readonly options: InputPageOptions,
	) {
		this.input = new Input({
			placeholder: options.placeholder,
			placeholderStyle: (text) => theme.fg("dim", text),
		});
		if (options.initialValue !== undefined) this.setValue(options.initialValue);
	}

	/** 本页在面包屑中的名字（由抽屉渲染） */
	title(): string {
		return this.options.title;
	}

	/** 底部键位提示（由抽屉统一渲染） */
	footerHints(): string {
		return "Enter 提交 · Esc 返回";
	}

	/** 当前输入值（测试与调用方读取） */
	getValue(): string {
		return this.input.getValue();
	}

	/**
	 * 覆盖输入值并**把光标移到行尾**。
	 * 注意：pi-tui Input.setValue 把光标留在行首（不跟随值），
	 * 若不处理，预填后打字/退格都会作用在错误位置。
	 */
	setValue(value: string): void {
		this.input.setValue(value);
		this.input.handleInput("\x1b[F"); // End：光标移行尾
	}

	/** 当前错误文案（null = 无） */
	getError(): string | null {
		return this.error;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = this.input.render(Math.max(1, safeWidth - 4)).map((line) => `  ${line}`);
		if (this.error) lines.push(`  ${this.theme.fg("error", `✗ ${this.error}`)}`);
		if (this.options.note) lines.push(`  ${this.theme.fg("dim", `注：${this.options.note}`)}`);
		return lines;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "esc")) {
			this.options.onCancel();
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return")) {
			this.submit();
			return;
		}
		this.input.handleInput(data);
		// 继续输入即清除错误，避免"改了还显示旧错"
		if (this.error) this.error = null;
	}

	/** 提交：就地校验，失败只记录错误 */
	private submit(): void {
		const value = this.input.getValue();
		const message = this.options.validate?.(value) ?? null;
		if (message) {
			this.error = message;
			return;
		}
		this.options.onSubmit(value);
	}
}
