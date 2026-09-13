/**
 * 命令面单一数据源：dispatch（switch）、命令补全、help 渲染三处共用。
 *
 * v5 命令面收敛为 6 个：无参（模型列表）/ rate / calendar / rule / plan / ai。
 * 这里只描述"有哪些命令、参数语义"，不含实现；实现见 pricing-commands.ts。
 */

/** 二级动作 */
export interface ChildSpec {
	/** 动作名（如 add） */
	name: string;
	/** 中文说明（补全菜单与 help 共用） */
	summary: string;
	/** 位置参数语义（供补全按列给候选） */
	args?: string[];
}

/** 一级子命令 */
export interface SubcommandSpec {
	/** 子命令名 */
	name: string;
	/** 中文说明 */
	summary: string;
	/** 位置参数语义 */
	args?: string[];
	/** 二级动作 */
	children?: ChildSpec[];
}

/**
 * 位置参数语义名（补全逻辑据它给动态候选）：
 * rateName / calendarName / ruleName / planName 为各表 name；
 * provider / model / field 有各自来源。
 */
export const PRICE_SUBCOMMANDS: SubcommandSpec[] = [
	{
		name: "rate",
		summary: "价格表：声明价格数值（不含时间条件）",
		children: [
			{ name: "list", summary: "列出全部价格" },
			{ name: "add", summary: "新建价格：add <name> <miss> <hit> <output>", args: ["name"] },
			{ name: "set", summary: "改数值：set <name> <field> <value>", args: ["rateName", "field"] },
			{ name: "remove", summary: "删除价格（被规则引用时拒绝）", args: ["rateName"] },
		],
	},
	{
		name: "calendar",
		summary: "日历表：命名日期资源（法定/民俗/促销等）",
		children: [
			{ name: "list", summary: "列出全部日历" },
			{ name: "add", summary: '新建日历：add <name> "<日期...>"', args: ["name"] },
			{ name: "add-dates", summary: '追加日期：add-dates <name> "<日期...>"', args: ["calendarName"] },
			{ name: "remove", summary: "删除日历（被规则引用时拒绝）", args: ["calendarName"] },
		],
	},
	{
		name: "rule",
		summary: "规则表：时间条件 + 一个价格引用",
		children: [
			{ name: "list", summary: "列出全部规则" },
			{
				name: "add",
				summary: "新建规则：add <name> <rateName> [--weekdays 1-5] [--ranges 09:00-12:00,...] [--include-cal N] [--exclude-cal N] [--include-dates ...] [--exclude-dates ...] [--valid-until YYYY-MM-DD]",
				args: ["name", "rateName"],
			},
			{ name: "remove", summary: "删除规则（被方案引用时拒绝）", args: ["ruleName"] },
		],
	},
	{
		name: "plan",
		summary: "方案表：规则组，模型唯一对接对象",
		children: [
			{ name: "list", summary: "列出全部方案（含引用它的模型）" },
			{ name: "add", summary: '新建方案：add <name> ["<alias>"]', args: ["name"] },
			{ name: "set-alias", summary: '设置别名：set-alias <name> "<alias>"', args: ["planName"] },
			{ name: "add-rule", summary: "纳入规则：add-rule <planName> <ruleName>", args: ["planName", "ruleName"] },
			{ name: "remove-rule", summary: "移出规则：remove-rule <planName> <ruleName>", args: ["planName", "ruleName"] },
			{ name: "bind", summary: "绑定模型：bind <provider> <model> <planName>", args: ["provider", "model", "planName"] },
			{ name: "enable-model", summary: "启用模型：enable-model <provider> <model>", args: ["provider", "model"] },
			{ name: "disable-model", summary: "禁用模型：disable-model <provider> <model>", args: ["provider", "model"] },
			{ name: "remove", summary: "删除方案（被模型绑定时拒绝）", args: ["planName"] },
		],
	},
	{
		name: "ai",
		summary: "AI 辅助配置：本次会话内允许 agent 修改配置（需确认后落盘）",
		children: [
			{ name: "on", summary: "启用 AI 编辑模式（默认行为，可省略）" },
			{ name: "off", summary: "停用 AI 编辑模式" },
		],
	},
];

/** 价格可改字段（rate set 的第二列） */
export const RATE_FIELDS = ["inputMiss", "inputHit", "output"] as const;

/** 按名字查一级子命令 */
export function findSubcommand(name: string): SubcommandSpec | undefined {
	return PRICE_SUBCOMMANDS.find((s) => s.name === name);
}

/** 全部一级子命令名 */
export function subcommandNames(): string[] {
	return PRICE_SUBCOMMANDS.map((s) => s.name);
}

/** AI 编辑模式涉及的工具名（批次④向 pi 注册后由 /price ai 激活） */
export const PRICE_AI_TOOL_NAMES = [
	"price_get",
	"price_apply",
	"price_review",
	"price_save",
	"price_discard",
] as const;

/** 取某子命令的二级动作名列表 */
export function childNames(sub: SubcommandSpec | undefined): string[] {
	return sub?.children?.map((c) => c.name) ?? [];
}
