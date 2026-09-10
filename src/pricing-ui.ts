/**
 * 表现层：三级钻取抽屉（厂商 → 模型 → 详情）。
 *
 * 对应 DESIGN.md 的 Shell：accent 双边框 + 标题随时间层变化 + SettingsList
 * 原生 submenu 机制做下钻（Enter 进入子级，Esc 逐级返回），搜索可过滤。
 * 无 TUI（headless）时 open() 返回 false，由接线层回退成 /price list 文本。
 */

import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	SettingsList,
	Text,
	type Component,
	type SettingItem,
} from "@earendil-works/pi-tui";
import { listModelRows, listProviderRows } from "./pricing-builder.ts";
import { renderModelDetail } from "./pricing-format.ts";

/** 抽屉第 0 级的标题（返回厂商列表时恢复） */
const ROOT_TITLE = "模型计费配置 · 厂商";

/** 抽屉标题的换行级别格式 */
function levelTitle(crumb: string): string {
	return `模型计费配置 · ${crumb}`;
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
		await (ui.custom as (factory: unknown) => Promise<unknown>)((tui: unknown, theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, _kb: unknown, done: (result?: undefined) => void) => {
			return this.buildScene(theme, () => done(undefined));
		});
		return true;
	}

	/** 组装抽屉场景（边框 + 动态标题 + 第 0 级厂商列表） */
	private buildScene(
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
		close: () => void,
	): Component {
		const container = new Container();
		const title = new Text(theme.fg("accent", theme.bold(ROOT_TITLE)), 1, 1);
		/** 换标题并强制重绘（submenu 钻取/返回时调用） */
		const setTitle = (text: string): void => {
			title.setText(theme.fg("accent", theme.bold(text)));
			container.invalidate();
		};

		let rootList: SettingsList | null = null;
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));
		container.addChild(title);
		rootList = this.buildProviderList(theme, setTitle, close);
		container.addChild(rootList);
		container.addChild(new DynamicBorder((s: string) => theme.fg("borderAccent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => rootList?.handleInput?.(data),
		};
	}

	/** 第 0 级：厂商列表（Enter 下钻到该厂商的模型列表） */
	private buildProviderList(
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
		setTitle: (text: string) => void,
		close: () => void,
	): SettingsList {
		const rows = listProviderRows(this.filePath);
		const items: SettingItem[] = rows.map((row) => ({
			id: row.providerId,
			label: `${row.providerId}  (${row.modelCount}模型 · ${row.peakDesc})`,
			currentValue: "",
			description: row.description,
			submenu: (_currentValue, done) => {
				setTitle(levelTitle(row.providerId));
				return this.buildModelList(theme, row.providerId, setTitle, () => {
					setTitle(ROOT_TITLE);
					done(undefined);
				});
			},
		}));
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
		theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
		providerId: string,
		setTitle: (text: string) => void,
		goBack: () => void,
	): SettingsList {
		const rows = listModelRows(providerId, this.filePath);
		const items: SettingItem[] = rows.map((row) => ({
			id: row.modelId,
			label: `${row.modelId}  out ${row.outputText} · miss ${row.inputText}`,
			currentValue: "",
			description: row.description,
			submenu: (_currentValue, done) => {
				setTitle(levelTitle(`${providerId}/${row.modelId}`));
				return this.buildDetail(providerId, row.modelId, () => {
					setTitle(levelTitle(providerId));
					done(undefined);
				});
			},
		}));
		return new SettingsList(
			items,
			Math.min(items.length + 4, 12),
			getSettingsListTheme(),
			() => {},
			goBack,
			{ enableSearch: true },
		);
	}

	/** 第 2 级：纯文本详情页（Enter 无动作；Esc 返回模型列表） */
	private buildDetail(providerId: string, modelId: string, goBack: () => void): Component {
		const body = renderModelDetail(providerId, modelId, this.filePath);
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