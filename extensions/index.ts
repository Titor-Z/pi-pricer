import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PricingCommands } from "../src/pricing-commands.ts";

export default function (pi: ExtensionAPI): void {
	new PricingCommands().mount(pi);
}
