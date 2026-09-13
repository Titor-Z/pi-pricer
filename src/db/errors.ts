/**
 * 数据层结构化错误：唯一性冲突 / 悬空引用 / 通用校验失败。
 *
 * 为什么单独一类：命令层与 AI 工具都需要"可读原因 + 结构化字段"来定位与自纠，
 * 若只抛裸 Error("xxx") 则调用方只能做字符串匹配。三个类都显式设置 name，
 * 保证继承后的 instanceof 与 name 判断在不同打包环境下一致。
 *
 * 注意：错误类名占用 Error.name，因此"冲突的 name 值"改名为 conflictName。
 */

/** 唯一 name 冲突（同一集合内 name 重复） */
export class UniqueNameError extends Error {
	/** 冲突所在集合名（rates / calendars / rules / plans / models） */
	readonly collection: string;
	/** 冲突的 name 值 */
	readonly conflictName: string;
	/** 已占用该 name 的文档 _id（更新自身时为自身 _id） */
	readonly ownerId: string;

	constructor(collection: string, conflictName: string, ownerId: string) {
		super(`集合 "${collection}" 中已存在同名文档 "${conflictName}"（_id=${ownerId}）`);
		this.name = "UniqueNameError";
		this.collection = collection;
		this.conflictName = conflictName;
		this.ownerId = ownerId;
	}
}

/** 悬空引用（引用的目标 _id 不存在） */
export class DanglingRefError extends Error {
	/** 引用者路径（如 `plans[0].ruleIds[1]`） */
	readonly path: string;
	/** 缺失的目标 _id */
	readonly targetId: string;
	/** 目标所在集合名 */
	readonly targetCollection: string;

	constructor(path: string, targetCollection: string, targetId: string) {
		super(`${path} 引用了不存在的 ${targetCollection} 文档（_id=${targetId}）`);
		this.name = "DanglingRefError";
		this.path = path;
		this.targetCollection = targetCollection;
		this.targetId = targetId;
	}
}

/** 通用校验失败（可携带多条原因） */
export class ValidationError extends Error {
	/** 失败原因列表（按发现顺序） */
	readonly issues: string[];

	constructor(issues: string[]) {
		super(`校验失败：\n- ${issues.join("\n- ")}`);
		this.name = "ValidationError";
		this.issues = issues;
	}
}

/** 乐观锁冲突（文件在加载后被外部修改，拒绝提交以防丢更新） */
export class ConcurrencyError extends Error {
	/** 配置文件的绝对/展示路径 */
	readonly filePath: string;

	constructor(filePath: string) {
		super(`配置文件已被外部修改，提交被拒绝（防止覆盖他人改动）：${filePath}`);
		this.name = "ConcurrencyError";
		this.filePath = filePath;
	}
}
