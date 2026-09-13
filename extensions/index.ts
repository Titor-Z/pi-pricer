/**
 * pi-pricer 扩展入口：挂载 /price 命令（6 个子命令）+ 注册 5 个 AI 工具（默认不激活）。
 *
 * AI 工具始终注册（声明存在），由 /price ai 确认后加入 active tools；
 * 未启用时工具返回指引文本，模型在系统提示里也看不到它们。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PricingCommands } from "../src/pricing-commands.ts";
import { PricingAgentTools } from "../src/pricing-agent-tool.ts";
import { PricingAgentService } from "../src/pricing-agent.ts";

export default function (pi: ExtensionAPI): void {
	const aiTools = new PricingAgentTools(new PricingAgentService());
	aiTools.register(pi);
	new PricingCommands(undefined, aiTools).mount(pi);
}
