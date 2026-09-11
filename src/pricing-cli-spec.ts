/**
 * CLI 子命令单一数据源：供 dispatch（switch）、命令补全、help 渲染三处共用。
 *
 * 为什么需要这个模块：v0.8 之前子命令表散落在三处（switch 分支、renderHelp 的
 * 硬编码字符串、无补全），改名或新增时极易漂移。这里把"命令面"收敛成一份数据，
 * 其余三处从它派生 —— 补全列表与实现不一致的问题从根上消失。
 */

/** 子命令分组（决定 help 里的分节与顺序） */
export type SubcommandGroup = "models" | "manage" | "debug";

/** 二级动作（如 scheme create） */
export interface ChildSpec {
	/** 动作名（如 create） */
	name: string;
	/** 中文说明（补全菜单与 help 共用） */
	summary: string;
	/** 位置参数语义（供补全按列给候选，如 ["id", "name"]） */
	args?: string[];
}

/** 一级子命令 */
export interface SubcommandSpec {
	/** 子命令名（如 scheme） */
	name: string;
	/** 中文说明 */
	summary: string;
	/** 分组 */
	group: SubcommandGroup;
	/** 位置参数语义；空数组/未声明 = 无位置参数 */
	args?: string[];
	/** 二级动作 */
	children?: ChildSpec[];
}

/** 分组显示名（help 分节标题） */
export const GROUP_TITLES: Record<SubcommandGroup, string> = {
	models: "模型与绑定（默认面）",
	manage: "管理面（TUI 下直达对应管理页；headless 输出文本）",
	debug: "调试与参考",
};

/** 分组渲染顺序 */
export const GROUP_ORDER: SubcommandGroup[] = ["models", "manage", "debug"];

/**
 * 全部一级子命令（命令面的唯一真相）。
 * args 里的语义名与补全逻辑（pricing-commands）约定一致：
 * provider / model / plan / price / calendar / ts / direction 是有动态来源的列。
 */
export const PRICE_SUBCOMMANDS: SubcommandSpec[] = [
	{
		name: "model",
		summary: "模型详情（绑定方案 + 实时生效价）",
		group: "models",
		args: ["provider", "model"],
	},
	{
		name: "list",
		summary: "模型计费总览（文本表格）",
		group: "models",
	},
	{
		name: "bind",
		summary: "为模型追加方案绑定（末尾 = 最低优先级）",
		group: "models",
		args: ["provider", "model", "plan"],
	},
	{
		name: "unbind",
		summary: "移除模型绑定",
		group: "models",
		args: ["provider", "model", "plan"],
	},
	{
		name: "move",
		summary: "调整绑定优先级（数组顺序 = 优先级）",
		group: "models",
		args: ["provider", "model", "plan", "direction"],
		children: [
			{ name: "up", summary: "上移一位" },
			{ name: "down", summary: "下移一位" },
			{ name: "top", summary: "移到最高优先级" },
			{ name: "bottom", summary: "移到最低优先级" },
		],
	},
	{
		name: "scheme",
		summary: "方案管理：列表 / 详情 / 新建 / 复制 / 删除",
		group: "manage",
		children: [
			{ name: "create", summary: "新建方案（默认挂首个价格实体）", args: ["id", "name"] },
			{ name: "duplicate", summary: "复制方案", args: ["id"] },
			{ name: "delete", summary: "删除方案（被绑定时拒绝）", args: ["id"] },
		],
	},
	{
		name: "rate",
		summary: "价格管理：注册表 / 新建 / 改值 / 删除",
		group: "manage",
		children: [
			{ name: "create", summary: "新建价格实体（初值 0）", args: ["id", "name"] },
			{ name: "set", summary: "修改价格字段（input.miss|input.hit|output）", args: ["id", "field", "value"] },
			{ name: "delete", summary: "删除价格（被引用时拒绝）", args: ["id"] },
		],
	},
	{
		name: "calendar",
		summary: "日历管理：列表 / 新建 / 删除",
		group: "manage",
		children: [
			{ name: "add", summary: "新建日历（日期格式 YYYY-MM-DD 或 MM-DD）", args: ["id", "name", "dates"] },
			{ name: "remove", summary: "删除日历（被引用时拒绝）", args: ["id"] },
		],
	},
	{
		name: "resolve",
		summary: "调试命中链（可指定时间）",
		group: "debug",
		args: ["model", "provider", "ts"],
	},
	{
		name: "schema",
		summary: "v2 结构说明",
		group: "debug",
	},
	{
		name: "help",
		summary: "显示本帮助",
		group: "debug",
	},
];

/** 价格字段候选（rate set 的第二列） */
export const PRICE_FIELDS = ["input.miss", "input.hit", "output"] as const;

/** 按名字查一级子命令（未找到返回 undefined） */
export function findSubcommand(name: string): SubcommandSpec | undefined {
	return PRICE_SUBCOMMANDS.find((s) => s.name === name);
}

/** 全部一级子命令名（供一致性测试与补全复用） */
export function subcommandNames(): string[] {
	return PRICE_SUBCOMMANDS.map((s) => s.name);
}
