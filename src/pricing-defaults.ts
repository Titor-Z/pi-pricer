/**
 * 内置默认价格（09-10 平台账单实测验证）。
 *
 * 用途：首次启动时 seeding 到 ~/.pi/model-pricing.json；
 * 同时作为 JSON 损坏/缺失时的 fallback。
 */

import type { PricingSchema } from "./pricing-types.ts";

export const DEFAULT_PRICING: PricingSchema = {
	version: 1,
	providers: {
		deepseek: {
			peakHours: {
				timezone: "Asia/Shanghai",
				weekdays: [1, 2, 3, 4, 5],
				ranges: [[9, 12], [14, 18]],
			},
			models: {
				"deepseek-flash": {
					alias: "deepseek-v4-flash",
					input: { miss: 1, hit: 0.02 },
					output: { standard: 4, peak: 8 },
				},
				"deepseek-v4-pro": {
					input: { miss: 4.5, hit: 0.15 },
					output: { standard: 13.5, peak: 27 },
				},
			},
		},
		glm: {
			peakHours: null,
			models: {
				"glm-5.3-flash": {
					input: { miss: 0.8, hit: 0.23 },
					output: { standard: 2.8, peak: null },
				},
			},
		},
	},
};
