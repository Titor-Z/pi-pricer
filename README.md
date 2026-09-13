# pi-pricer

**Pi Agent 的模型计费配置中心** —— 统一的模型价格与规则引擎。

价格、日历、规则、方案与模型绑定集中维护在一份 `~/.pi/model-pricing.json`，通过 `/price` 管理；
消费方扩展（pi-usager、pi-prompt 等）读取同一份数据源，厂商调价只需改一处，全生态即刻生效。

*Model pricing config & rules engine for Pi extensions — one shared price table, many consumers.*

---

## 安装

```bash
pi extension add @foolsecret/pi-pricer
```

首次启动会写入一份内置默认价表（基于实测账单校准），开箱可用。
pi-pricer 只负责价格的制定与存储，不做用量统计或费用展示——那是消费方的事。

## 快速开始

```bash
/price                                       # 打开计费面板
/price rate set "DeepSeek 谷价" output 4     # 修改价格
/price rate                                  # 查看价格表
/price plan                                  # 查看方案表
```

面板键位：`↑↓` 移动 · `Enter` 执行 · `Esc` 返回 · `Ctrl+S` 保存 · `Ctrl+R` 重置 · `PgUp/PgDn` 翻页。

## 命令

| 命令 | 说明 |
| --- | --- |
| `/price` | 打开面板；无 TUI 时输出文本列表 |
| `/price rate` | 价格表：`list` / `add` / `set` / `remove` |
| `/price calendar` | 日历表：`list` / `add` / `add-dates` / `remove` |
| `/price rule` | 规则表：`list` / `add` / `remove` |
| `/price plan` | 方案表：`list` / `add` / `set-alias` / `add-rule` / `remove-rule` / `bind` / `enable-model` / `disable-model` / `remove` |
| `/price ai` | 会话级启用 AI 编辑：`on` / `off` |

- 带二级动作时走文本执行，便于脚本化；名称含空格用引号包裹。
- 规则选项：`--weekdays 1-5`、`--ranges 09:00-12:00,14:00-18:00`、`--include-cal …`、`--exclude-cal …`、`--include-dates …`、`--exclude-dates …`、`--valid-until 2026-12-31`、`--timezone Asia/Shanghai`。
- 支持 Tab 补全：子命令 → 动作 → 配置中真实存在的 `name`。

## 数据模型

五个集合，document 之间以 `_id` 引用：

| 集合 | 字段 |
| --- | --- |
| `rates` | `name`、`inputMiss`、`inputHit`、`output`（¥ / 百万 token） |
| `calendars` | `name`、`region?`、`dates`（`MM-DD` 循环或 `YYYY-MM-DD`） |
| `rules` | `name`、`rateId`、`timezone`、`weekdays`、`ranges`、`includeCalendars`、`excludeCalendars`、`includeDates`、`excludeDates`、`validUntil?` |
| `plans` | `name`、`alias?`、`ruleIds` |
| `models` | `provider`、`model`、`planId`、`enabled` |

**解析**：`models` 命中 `(provider, model)` → 取其方案；`enabled === false` 或方案缺失则走兜底价 →
否则按方案内规则取价。

**匹配**：单条规则内各条件为**交集**（星期、时段、日历、日期全部成立才命中）；规则之间按
`createdAt` **后创建覆盖先创建**。因此先建兜底（全时）规则，再建特例（峰时段）规则。

`provider` 一律使用 Pi 真实 provider id（`deepseek`、`zai` …）。

### 配置示例

```jsonc
{
  "version": 5,
  "rates": [
    { "name": "DeepSeek 谷价",    "inputMiss": 1,   "inputHit": 0.02, "output": 4 },
    { "name": "DeepSeek 峰价",    "inputMiss": 2,   "inputHit": 0.04, "output": 8 }
  ],
  "rules": [
    { "name": "DeepSeek 全时谷价", "rateId": "…", "timezone": "Asia/Shanghai" },
    { "name": "DeepSeek 工作日高峰", "rateId": "…",
      "weekdays": [1, 2, 3, 4, 5], "ranges": [["09:00", "12:00"], ["14:00", "18:00"]] }
  ],
  "plans": [
    { "name": "deepseek-v4-flash 方案", "alias": "Flash 默认", "ruleIds": ["…", "…"] }
  ],
  "models": [
    { "provider": "deepseek", "model": "deepseek-v4-flash", "planId": "…", "enabled": true }
  ]
}
```

`_id` / `createdAt` 由程序管理，手写配置可省略。完整字段见 `./src/pricing-types.ts`。

## 常见配置

| 场景 | 做法 |
| --- | --- |
| 高峰 / 低谷 | 先建「全时谷价」规则，再建「工作日峰时段」规则（特例覆盖兜底） |
| 节假日不按峰价 | 峰规则加 `--exclude-cal "中国法定节假日"` |
| 促销日专属低价 | 建促销日历，规则加 `--include-cal "促销日"` |
| 规则到期下线 | 加 `--valid-until 2026-12-31` |
| 多模型共用方案 | 多个 `model` 绑定同一 `plan` |

## 扩展开发者 API

```ts
import { resolvePricing, createPricingResolver } from "@foolsecret/pi-pricer/pricing";

// 单次查询
const price = resolvePricing("deepseek-v4-flash", "deepseek", new Date());
// → { inputMiss, inputHit, output, isPeak, planId?, planName?, planAlias?, rateId?, ruleId? }

// 批量：一次读盘，复用闭包（推荐逐帧调用方使用）
const resolve = createPricingResolver();
```

导出子路径：`/pricing`（查询）、`/store`（存储）、`/types`（类型）、`/db`（事务化 DAO）。

## AI 辅助配置

`/price ai` 在当前会话启用 AI 编辑。启用后可将价目表、账单或文档交给 agent：它读取现状、
解析资料、提交结构化动作；改动先进入草稿，经确认后落盘。未启用时相关工具对模型完全不可见。
配套 `price-config` skill 提供工作流说明。

## 兼容性

- 当前 Schema **v5**，与 ≤ 0.12 的旧结构不兼容。
- 消费方需使用适配 v5 的版本：pi-usager ≥ **2.4.0**（0.15.0 起 provider 契约统一为 Pi 真实 id）。
- 读到旧版本文件时以 v5 内置种子运行，**不改写旧文件**；保存时才写成 v5。

## License

AGPL-3.0-only
