---
name: price-config
description: Configure pi's model pricing (model-pricing.json) from a price list, bill, invoice, or documentation the user provides. Use when the user gives you pricing data or asks you to change how a model is billed (prices, holiday calendars, rules, plans, model bindings). Requires the user to have run /price ai first.
---

# 模型计费配置（AI 辅助，schema v5）

帮用户把价格资料（网页文本、账单、价目表、截图里的文字）落成 pi 的计费配置。

## 前置条件

**必须先让用户执行 `/price ai` 启用 AI 编辑模式**（本次会话内有效）。
未启用时 `price_*` 工具不在可用工具列表中；若调用返回"未启用"提示，
请明确告诉用户先执行该命令，不要自己想办法绕过。

## 硬性禁止

- **禁止**用 `edit` / `write` / `bash` 直接修改 `~/.pi/model-pricing.json`。
  直接改文件会绕过校验与引用保护。所有改动一律走 `price_apply`。
- **禁止猜测**。价格、日期、时段、星期、时区、模型名、厂商名——任何一项资料里
  没写清楚，都要问用户，不要填一个"看起来合理"的值。
- **禁止**在用户确认前落盘。落盘只能通过 `price_save`。

## 数据模型（五张表，靠 name 互相引用）

| 表 | 作用 | 关键字段 |
|---|---|---|
| **价格 rate** | 只声明数值，不含任何时间条件 | `name`（唯一）, `inputMiss`, `inputHit`, `output` |
| **日历 calendar** | 命名日期资源（法定/民俗/促销日） | `name`（唯一）, `dates`（`YYYY-MM-DD` 或 `MM-DD`） |
| **规则 rule** | 时间条件 + 一个价格引用 | `name`（唯一）, `rateName`, `timezone`, `weekdays`, `ranges`, `includeCalendars`, `excludeCalendars`, `includeDates`, `excludeDates`, `validUntil` |
| **方案 plan** | 规则组，模型唯一对接对象 | `name`（唯一）, `alias`, `enabled`, `ruleNames` |
| **模型 model** | 厂商 + 模型名 + 绑定的方案 | `provider`, `model`, `planName` |

**动作里引用实体一律用 `name`（唯一），不要用 `_id`。**

### 规则的匹配语义

一条规则在"各条件的**交集**"内生效：

1. `validUntil` 过期 → 不生效
2. 命中 `excludeDates` / `excludeCalendars` → 不生效（排除优先）
3. 若给了 `includeCalendars`，日期必须在其中某个日历里
4. 若给了 `includeDates`，日期必须命中
5. `weekdays` 为空 = 任意星期；否则需命中（1=周一…7=周日）
6. `ranges` 为空 = 全天；否则需落在某个 `["HH:MM","HH:MM")` 内

### 规则优先级（重要）

同一方案内，**后创建的规则覆盖先创建的规则**（交集处覆盖，互不影响处各自生效）。
因此：**先建兜底规则（如"全时谷价"），后建特例规则（如"工作日高峰"）**，
特例才能在重叠时段胜出。

## 格式规范

| 字段 | 格式 |
|---|---|
| 价格 | number，¥/百万 token，非负 |
| 日期 | `YYYY-MM-DD`（精确）或 `MM-DD`（每年循环，节假日用这个） |
| 时段 | `["HH:MM","HH:MM"]` 半开区间，含头不含尾；跨天拆两段 |
| 星期 | 1–7（1=周一）；空数组 = 任意 |
| 时区 | IANA 名，如 `Asia/Shanghai`；不填默认 `Asia/Shanghai` |

## 工作流

1. **读现状**：`price_get`，看清现有价格/日历/规则/方案/模型，注意命名习惯。
2. **解析资料**：整理成结构化字段；单位统一为 ¥/百万 token，若资料是别的单位先换算并告知。
3. **补齐缺失**：资料没有的（时区、星期、日历等）问用户；只有时区可默认 `Asia/Shanghai` 并说明。
4. **应用改动**：`price_apply` 一次传完整一批动作，顺序为
   **先价格/日历 → 再规则 → 再方案 → 最后绑模型**（被引用的先建）。
   调用顺序按创建时间：同一方案内先兜底规则、后特例规则。
5. **确认**：`price_review`，把改动预览给用户看。
6. **落盘**：用户确认后 `price_save`。保存被拒时按原因修正后重试。
7. **报告**：说明改了哪些实体与落盘结果。

## 可用动作（price_apply 的 actions）

`upsertRate` / `deleteRate` / `upsertCalendar` / `addCalendarDates` / `deleteCalendar` /
`upsertRule` / `deleteRule` / `upsertPlan` / `setPlanEnabled` / `deletePlan` /
`bindModel` / `unbindModel`

- `upsert*` 按 `name` 定位：不存在则新建，存在则覆盖所给字段。
- 一批动作**整批原子**：任一动作失败则整批回滚，需修正后整批重发。

## 场景示例

### 一、某模型的峰/谷价

资料："deepseek-v4-pro 工作日 9-12、14-18 输出 27 输入 9，其余时间输出 13.5 输入 4.5，缓存命中为输入的三折"

```
price_apply actions:
  1. upsertRate  { name: "Pro 谷价", inputMiss: 4.5,  inputHit: 1.35, output: 13.5 }
  2. upsertRate  { name: "Pro 峰价", inputMiss: 9,    inputHit: 2.7,  output: 27 }
  3. upsertRule  { name: "Pro 全时谷价", rateName: "Pro 谷价" }                          // 兜底，先建
  4. upsertRule  { name: "Pro 工作日高峰", rateName: "Pro 峰价",
                   weekdays: [1,2,3,4,5], ranges: [["09:00","12:00"],["14:00","18:00"]] } // 特例，后建
  5. upsertPlan  { name: "deepseek-v4-pro 方案", alias: "Pro", ruleNames: ["Pro 全时谷价", "Pro 工作日高峰"] }
  6. bindModel   { provider: "deepseek", model: "deepseek-v4-pro", planName: "deepseek-v4-pro 方案" }
```

### 二、节假日日历 + 节假日不按峰价

资料："中国法定节假日：元旦 1-1，国庆 10-1 到 10-7"

```
price_apply actions:
  1. upsertCalendar { name: "中国法定节假日",
                      dates: ["01-01","10-01","10-02","10-03","10-04","10-05","10-06","10-07"] }
  2. upsertRule     { name: "Pro 工作日高峰（排除节假日）", rateName: "Pro 峰价",
                      weekdays: [1,2,3,4,5], ranges: [["09:00","12:00"],["14:00","18:00"]],
                      excludeCalendars: ["中国法定节假日"] }   // 同名覆盖，追加排除
```

引用日历时给日历的 `name`。

### 三、节假日专属低价

```
price_apply actions:
  1. upsertCalendar { name: "促销日", dates: ["2026-11-11"] }
  2. upsertRule     { name: "双十一促销", rateName: "促销价", includeCalendars: ["促销日"] }  // 后建 → 覆盖
```

## 出错时怎么办

`price_apply` 失败会整批回滚并返回每条原因。常见自纠：

- **引用的实体不存在**：同一批里把被引用者（价格/日历/规则）排在引用者之前。
- **name 重复**：同名 `upsert*` 会覆盖而非新建；若想新建请换一个名字。
- **保存被拒（引用完整性 / 乐观锁）**：按原因修正；乐观锁冲突说明文件被外部改过，让用户重开或重新读取。

任何一步不确定，停下来问用户。宁可少改，不可乱改。
