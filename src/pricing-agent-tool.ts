/**
 * AI 辅助配置的 5 个自定义工具（price_get / price_apply / price_review / price_save / price_discard）。
 *
 * 安全性靠能力隔离：工具始终 register（声明存在），但默认**不激活**；
 * 由 /price ai 确认后调用 pi.setActiveTools 加入激活集，模型才会看到并调用。
 * 未启用时工具返回指引文本而非抛错（抛错会中断 agent 整个回合）。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { PricingActionSchema, type PricingAction } from "./pricing-agent-actions.ts";
import { PricingAgentService } from "./pricing-agent.ts";

/** 工具返回的文本结果 */
function text(message: string): AgentToolResult<Record<string, never>> {
	return { content: [{ type: "text", text: message }], details: {} };
}

/** 未启用时的统一指引 */
const DISABLED_HINT = "AI 编辑模式未启用。请让用户先执行 /price ai，然后再重试本工具。";

/** 5 个工具的注册与执行 */
export class PricingAgentTools {
	/** 会话级启用开关（由 /price ai 切换） */
	private enabled = false;

	constructor(
		private readonly service: PricingAgentService = new PricingAgentService(),
	) {}

	/** 切换启用状态（/price ai 调用） */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/** 是否已启用 */
	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 向 pi 注册全部工具（不激活） */
	register(pi: ExtensionAPI): void {
		pi.registerTool({
			name: "price_get",
			label: "读取计费配置现状",
			description: "读取当前模型计费配置的语义摘要（价格/日历/规则/方案/模型绑定）。修改前先调用它了解现状。",
			promptSnippet: "读取模型计费配置现状",
			promptGuidelines: [
				"修改计费配置前，先用 price_get 了解现有实体与命名习惯。",
				"用户给了价格资料时要落到计费配置时，用 price_apply 提交结构化动作。",
			],
			parameters: Type.Object({}),
			execute: async () => this.guard(() => text(this.service.getSummary())),
		});

		pi.registerTool({
			name: "price_apply",
			label: "应用计费改动",
			description:
				"把一组结构化动作应用到计费配置草稿（不落盘）。任一动作失败则整批回滚。落盘需再调用 price_review 与 price_save。",
			promptSnippet: "应用计费改动到草稿",
			promptGuidelines: [
				"一次 price_apply 传入完整的一批动作（先建被引用的价格/日历/规则，再建方案，最后绑定模型）。",
				"引用一律用各表的 name（唯一），不要使用 _id。",
			],
			parameters: Type.Object({
				actions: Type.Array(PricingActionSchema, { minItems: 1, description: "要应用的语义动作列表" }),
			}),
			execute: async (_id: string, params: { actions: PricingAction[] }) => {
				return this.guard(() => {
					const result = this.service.applyActions(params.actions);
					if (!result.ok) {
						const lines = result.failures.map((f) => `- [${f.kind}] ${f.reason}`);
						return text(`改动未生效（整批回滚）：\n${lines.join("\n")}`);
					}
					return text(`已应用到草稿（尚未落盘）：\n${this.service.diffPreview()}\n\n请调用 price_review 让用户确认，再调用 price_save 落盘。`);
				});
			},
		});

		pi.registerTool({
			name: "price_review",
			label: "预览计费改动",
			description: "展示草稿中尚未保存的计费改动预览，供用户确认。",
			promptSnippet: "预览尚未保存的计费改动",
			promptGuidelines: ["price_apply 之后、price_save 之前，先调用 price_review 给用户看改动。"],
			parameters: Type.Object({}),
			execute: async () => this.guard(() => text(this.service.diffPreview())),
		});

		pi.registerTool({
			name: "price_save",
			label: "保存计费配置",
			description: "把草稿落盘到 ~/.pi/model-pricing.json。首次保存会请求用户确认；校验失败会拒绝写入。",
			promptSnippet: "保存计费配置到磁盘",
			promptGuidelines: [
				"只有在 price_review 展示过改动、用户表示确认后，才调用 price_save。",
				"保存被拒绝时按返回原因修正后重试，不要绕过。",
			],
			parameters: Type.Object({}),
			execute: async () => {
				if (!this.enabled) return text(DISABLED_HINT);
				const result = await this.service.commit();
				if (!result.ok) return text(`保存失败：${result.reason}`);
				return text("保存成功：已写入 ~/.pi/model-pricing.json");
			},
		});

		pi.registerTool({
			name: "price_discard",
			label: "丢弃计费改动",
			description: "丢弃草稿中所有未保存的计费改动，重新从磁盘读取配置。",
			promptSnippet: "丢弃未保存的计费改动",
			promptGuidelines: ["用户要求放弃改动时，用 price_discard 而非直接改文件。"],
			parameters: Type.Object({}),
			execute: async () => this.guard(() => {
				this.service.discard();
				return text("已丢弃未保存改动，配置回到磁盘状态。");
			}),
		});
	}

	/** 统一守卫：未启用返回指引；其余异常转成结构化失败文本 */
	private guard(run: () => AgentToolResult<Record<string, never>>): AgentToolResult<Record<string, never>> {
		if (!this.enabled) return text(DISABLED_HINT);
		try {
			return run();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return text(`操作失败：${message}`);
		}
	}
}
