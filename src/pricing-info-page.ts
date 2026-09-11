/**
 * 可复用的只读信息页：把结构化说明（help / schema / 解析链 / 模型详情）
 * 以 Markdown 排版渲染，自带固定高度滚动窗口。
 *
 * 为什么需要它：TUI 下结构化说明密集时，散落的纯文本页（buildTextPage）既无
 * 样式层级也无法滚动。这里统一成"Markdown 内容 + 自滚动窗口"一条通路：
 * - 内容侧：各 renderer 提供 markdown 字符串（数据驱动，headless 另有纯文本版）
 * - 载体侧：InfoPage 自管 scrollTop，按 MAX_INFO_LINES 切窗口，↑↓/PgUp/PgDn/Home/End
 *   滚动、Esc 返回（调用方传入 goBack，进入/退出语义由调用方决定）
 */

import { getKeybindings, Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

/** 信息页固定显示的最大行数（跟随 SettingsList 自限高惯例，不侵入布局系统） */
export const MAX_INFO_LINES = 16;

/** 抽屉主题（fg/bold 的最小依赖面；由 pi 的 ctx.ui.custom factory 注入真实色板） */
export interface DrawerTheme {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
}

/**
 * 把 DrawerTheme 映射成 pi-tui MarkdownTheme。
 * 标题用 mdHeading、代码用 mdCode / mdCodeBlock，正文继承默认样式。
 */
export function buildMarkdownTheme(theme: DrawerTheme): MarkdownTheme {
	return {
		heading: (text: string) => theme.fg("mdHeading", theme.bold(text)),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.fg("muted", text),
		strikethrough: (text: string) => theme.fg("dim", text),
		underline: (text: string) => text,
	};
}

/** 只读信息页：Markdown 渲染 + 固定高度窗口 + 内部滚动；Esc 走 goBack */
export class InfoPage implements Component {
	/** 已渲染的完整内容行缓存（Markdown 按宽度折行，宽变才重渲） */
	private cache: { width: number; lines: string[] } | null = null;
	private scrollTop = 0;
	private readonly markdown: Markdown;

	constructor(
		content: string,
		private readonly theme: DrawerTheme,
		private readonly goBack: () => void,
		/** 页脚注（dim 渲染在提示条下方，说明本页关键上下文） */
		private readonly notes: string[] = [],
	) {
		this.markdown = new Markdown(content, 1, 0, buildMarkdownTheme(theme));
	}

	/** 取完整内容行（按 width 缓存，内容不支持改动→invalidate 时清空） */
	private allLines(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const lines = this.markdown.render(width);
		this.cache = { width, lines };
		return lines;
	}

	/** 内容总行数（用于滚动边界） */
	private maxTop(): number {
		const total = this.cache ? this.cache.lines.length : 0;
		return Math.max(0, total - MAX_INFO_LINES);
	}

	render(width: number): string[] {
		const lines = this.allLines(width);
		if (this.scrollTop > this.maxTop()) this.scrollTop = this.maxTop();
		const window = lines.slice(this.scrollTop, this.scrollTop + MAX_INFO_LINES);
		// 底部固定提示条（与 ActionMenu 的键位提示风格一致）
		const hint = this.theme.fg("dim", "  ↑↓ 滚动 · PgUp/PgDn 翻页 · Esc 返回");
		const out = [...window, hint];
		for (const n of this.notes) out.push(this.theme.fg("dim", `  ${n}`));
		return out;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.goBack();
			return;
		}
		const maxTop = this.maxTop();
		if (kb.matches(data, "tui.select.up")) {
			this.scrollTop = Math.max(0, this.scrollTop - 1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.scrollTop = Math.min(maxTop, this.scrollTop + 1);
		} else if (kb.matches(data, "tui.select.pageUp") || kb.matches(data, "tui.altScreen.pageUp") || kb.matches(data, "tui.editor.pageUp")) {
			this.scrollTop = Math.max(0, this.scrollTop - MAX_INFO_LINES);
		} else if (kb.matches(data, "tui.select.pageDown") || kb.matches(data, "tui.altScreen.pageDown") || kb.matches(data, "tui.editor.pageDown")) {
			this.scrollTop = Math.min(maxTop, this.scrollTop + MAX_INFO_LINES);
		} else if (kb.matches(data, "tui.altScreen.top") || kb.matches(data, "tui.editor.cursorLineStart")) {
			this.scrollTop = 0;
		} else if (kb.matches(data, "tui.altScreen.bottom") || kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.scrollTop = maxTop;
		}
	}

	invalidate(): void {
		this.cache = null;
		this.markdown.invalidate();
	}
}