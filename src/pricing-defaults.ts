/**
 * v2 默认计费数据（种子 + 损坏回退）。
 *
 * 由 v1 内置默认价迁移而来；DeepSeek 平台峰时段输入+输出都翻倍，
 * 故峰价实体显式写峰输入价。数据来源：09-10 平台账单实测折算。
 */
import type { PricingSchemaV2 } from "./pricing-types.ts";

export const DEFAULT_PRICING: PricingSchemaV2 = {
	version: 2,
	calendars: {},
	prices: {
		"deepseek-valley": {
			name: "DeepSeek 谷价",
			input: { miss: 1, hit: 0.02 },
			output: 4,
		},
		"deepseek-peak": {
			name: "DeepSeek 峰价",
			input: { miss: 2, hit: 0.04 },
			output: 8,
		},
		"deepseek-pro-valley": {
			name: "DeepSeek Pro 谷价",
			input: { miss: 4.5, hit: 0.15 },
			output: 13.5,
		},
		"deepseek-pro-peak": {
			name: "DeepSeek Pro 峰价",
			input: { miss: 9, hit: 0.3 },
			output: 27,
		},
		"glm-standard": {
			name: "GLM 标准价",
			input: { miss: 0.8, hit: 0.23 },
			output: 2.8,
		},
	},
	plans: {
		"deepseek-peak-workday": {
			name: "工作日高峰",
			rules: [
				{
					schedule: {
						timezone: "Asia/Shanghai",
						weekdays: [1, 2, 3, 4, 5],
						ranges: [
							["09:00", "12:00"],
							["14:00", "18:00"],
						],
					},
					price: "deepseek-peak",
				},
			],
		},
		"deepseek-valley-always": {
			name: "全时谷价",
			rules: [
				{
					schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] },
					price: "deepseek-valley",
				},
			],
		},
		"deepseek-pro-peak-workday": {
			name: "Pro 工作日高峰",
			rules: [
				{
					schedule: {
						timezone: "Asia/Shanghai",
						weekdays: [1, 2, 3, 4, 5],
						ranges: [
							["09:00", "12:00"],
							["14:00", "18:00"],
						],
					},
					price: "deepseek-pro-peak",
				},
			],
		},
		"deepseek-pro-valley-always": {
			name: "Pro 全时谷价",
			rules: [
				{
					schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] },
					price: "deepseek-pro-valley",
				},
			],
		},
		"glm-always": {
			name: "GLM 全时标准价",
			rules: [
				{
					schedule: { timezone: "Asia/Shanghai", weekdays: [], ranges: [] },
					price: "glm-standard",
				},
			],
		},
	},
	providers: {
		deepseek: {
			models: {
				"deepseek-flash": {
					alias: "deepseek-v4-flash",
					plans: [
						{ plan: "deepseek-peak-workday", enabled: true },
						{ plan: "deepseek-valley-always", enabled: true },
					],
				},
				"deepseek-v4-pro": {
					plans: [
						{ plan: "deepseek-pro-peak-workday", enabled: true },
						{ plan: "deepseek-pro-valley-always", enabled: true },
					],
				},
			},
		},
		glm: {
			models: {
				"glm-5.3-flash": {
					plans: [{ plan: "glm-always", enabled: true }],
				},
			},
		},
	},
};