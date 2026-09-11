/**
 * AI 辅助配置的工具层：把 PricingAgentService 暴露成 agent 可调用的工具。
 *
 * 关键设计：工具"注册即存在，但不激活"。只有用户显式 `/price ai` 后，
 * PricingCommands 才把 price_* 加入 active tools。未激活时模型看不到也调不到 ——
 * 这是技术保证，不是文案约定。
 *
 * 安全：所有写入都经 draft（validate + 引用保护）+ 用户确认，见 pricing-agent.ts。
 */

import { Type } from "typebox";
import { PricingAgentService } from "./pricing-agent.ts";
import { PricingActionSchema } from "./pricing-agent-actions.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";

/** 全部工具名（启用/停用时用，单一来源防漂移） */
export const PRICING_AGENT_TOOL_NAMES = [
	"price_get",
	"price_apply",
	"price_review",
	"price_save",
	"price_discard",
] as const;

/** 未启用时的统一提示（agent 误调时给出可执行指引） */
const NOT_ENABLED = "AI 编辑模式未启用。请先让用户执行 /price ai（本次会话内有效），再重试。";

/** 工具共用的提醒文案：明确"必须用户显式授权" */
const ENABLE_HINT = "Use price_get/price_apply/price_review/price_save only when the user has enabled AI editing via /price ai in this session.";

/**
 * 工具集：每个工具都从同一个 PricingAgentService 读写，保证会话内一致。
 * 服务实例在启用时创建，停用时清空。
 */
export class PricingAgentTools {
	/** 当前会话的服务实例（undefined = 未启用 AI 编辑模式） */
	private service: PricingAgentService | undefined;

	/** 本次启用会话内是否已就首次落盘征求过确认 */
	private saveConfirmed = false;

	constructor(private readonly filePath?: string) {}

	/** 是否处于启用态 */
	get enabled(): boolean {
		return this.service !== undefined;
	}

	/** 启用：创建服务实例并重置确认状态 */
	enable(): void {
		this.service = new PricingAgentService(this.filePath);
		this.saveConfirmed = false;
	}

	/** 停用：丢弃实例（未保存改动就此作废，调用方需先提示） */
	disable(): void {
		this.service = undefined;
		this.saveConfirmed = false;
	}

	/**
	 * 注册全部工具（注册 ≠ 激活）。
	 * 每个工具配 promptSnippet + promptGuidelines，guideline 显式点名工具名。
	 */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "price_get",
			label: "读取计费配置",
			description: "读取 pi 的模型计费配置（~/.pi/model-pricing.json）并提出语义摘要，供修改前了解现状。只读，不修改任何内容。",
			promptSnippet: "读取模型计费配置摘要（只读）",
			promptGuidelines: [`Use price_get to inspect the current model pricing schema before making changes. ${ENABLE_HINT}`],
			parameters: Type.Object({}),
			execute: async () => this.run((svc) => ({
				content: [{ type: "text", text: svc.getSummary() }],
				details: { dirty: svc.isDirty },
			})),
		});

		pi.registerTool({
			name: "price_apply",
			label: "应用计费改动",
			description: "对模型计费配置应用一个或多个结构化改动（价格实体、方案、规则、绑定、日历）。改动先进入内存草稿，不会立即落盘；需随后调用 price_review 让用户确认，并调用 price_save 保存。",
			promptSnippet: "应用计费改动到内存草稿（不落盘）",
			promptGuidelines: [
				`Use price_apply to stage pricing changes as structured actions; it does not write to disk. ${ENABLE_HINT}`,
				"After price_apply, always call price_review so the user can inspect the change, then call price_save.",
			],
			parameters: Type.Object({
				actions: Type.Array(PricingActionSchema, { minItems: 1, description: "要应用的语义动作列表；单条失败不影响其余" }),
			}),
			execute: async (_id, params) => this.run((svc) => {
				const result = svc.applyActions(params.actions);
				return {
					content: [{ type: "text", text: this.renderApply(result) }],
					details: result,
				};
			}),
		});

		pi.registerTool({
			name: "price_review",
			label: "预览计费改动",
			description: "展示当前内存草稿中尚未保存的改动预览（改动后会写入的配置全貌），供用户确认。只读，不落盘。",
			promptSnippet: "预览未保存的计费改动",
			promptGuidelines: [`Use price_review to show the user what will be written before calling price_save. ${ENABLE_HINT}`],
			parameters: Type.Object({}),
			execute: async () => this.run(async (svc) => ({
				content: [{ type: "text", text: svc.diffPreview() }],
				details: { dirty: svc.isDirty },
			})),
		});

		pi.registerTool({
			name: "price_save",
			label: "保存计费配置",
			description: "把内存草稿落盘到 ~/.pi/model-pricing.json。首次保存会请求用户确认；校验失败（如引用不存在的价格或日历）则拒绝写入并返回原因。",
			promptSnippet: "把计费草稿落盘（首次需用户确认）",
			promptGuidelines: [`Use price_save only after price_review has shown the user the pending change. ${ENABLE_HINT}`],
			parameters: Type.Object({}),
			execute: async (_id, _params, _signal, _update, ctx) => this.run(async (svc) => {
				if (!svc.isDirty) {
					return { content: [{ type: "text", text: "没有未保存的改动，无需保存。" }], details: { saved: false } };
				}
				// 首次落盘前征求确认；会话内确认过一次就不再打扰
				const needConfirm = !this.saveConfirmed && ctx.hasUI;
				if (needConfirm) {
					const ok = await ctx.ui.confirm(
						"保存计费改动",
						`将写入 ${this.filePath ?? "~/.pi/model-pricing.json"}。\n\n${svc.diffPreview()}`,
					);
					if (!ok) {
						return { content: [{ type: "text", text: "用户取消了保存，改动仍留在内存草稿中（可用 price_discard 丢弃）。" }], details: { saved: false, cancelled: true } };
					}
					this.saveConfirmed = true;
				}
				const result = await svc.commit();
				const text = result.ok
					? `已保存：${this.filePath ?? "~/.pi/model-pricing.json"}`
					: `保存被拒绝：${result.reason}（改动仍在内存草稿中）`;
				return { content: [{ type: "text", text }], details: result };
			}),
		});

		pi.registerTool({
			name: "price_discard",
			label: "丢弃计费改动",
			description: "丢弃内存草稿中所有未保存的计费改动，重新从磁盘读取配置。",
			promptSnippet: "丢弃未保存的计费改动",
			promptGuidelines: [`Use price_discard when the user wants to abandon staged pricing changes. ${ENABLE_HINT}`],
			parameters: Type.Object({}),
			execute: async () => this.run((svc) => {
				svc.discard();
				return { content: [{ type: "text", text: "已丢弃全部未保存改动。" }], details: { dirty: false } };
			}),
		});
	}

	/**
	 * 工具执行统一入口：未启用时返回指引而非抛错（抛错会中断 agent 回合）。
	 * 其余异常也兜底成结构化文本，避免把栈信息糊到对话里。
	 */
	private async run(
		fn: (svc: PricingAgentService) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }> | { content: { type: "text"; text: string }[]; details: unknown },
	): Promise<{ content: { type: "text"; text: string }[]; details: unknown }> {
		if (!this.service) {
			return { content: [{ type: "text", text: NOT_ENABLED }], details: { enabled: false } };
		}
		try {
			return await fn(this.service);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { content: [{ type: "text", text: `操作失败：${reason}` }], details: { error: reason } };
		}
	}

	/** apply 结果渲染：成功项 + 失败项分开，失败项带原因（agent 据此自纠） */
	private renderApply(result: { applied: string[]; errors: { action: string; reason: string }[] }): string {
		const lines: string[] = [];
		lines.push(result.applied.length > 0 ? `已应用到内存草稿（${result.applied.length} 项）：` : "没有任何改动被应用。");
		for (const item of result.applied) lines.push(`  ✓ ${item}`);
		if (result.errors.length > 0) {
			lines.push("");
			lines.push(`失败 ${result.errors.length} 项：`);
			for (const item of result.errors) lines.push(`  ✗ ${item.action}：${item.reason}`);
		}
		lines.push("");
		lines.push("下一步：调用 price_review 让用户查看改动，再调用 price_save 保存。");
		return lines.join("\n");
	}
}

/** price_apply 的参数类型（供测试构造合法入参） */
export type PriceApplyParams = Static<typeof PricingActionSchema>;
