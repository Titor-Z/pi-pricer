---
name: price-config
description: Configure pi's model pricing (model-pricing.json) from a price list, bill, invoice, or documentation the user provides. Use when the user gives you pricing data or asks you to change how a model is billed (peak/off-peak prices, holiday calendars, plan bindings). Requires the user to have run /price ai first.
---

# 模型计费配置（AI 辅助）

帮用户把价格资料（网页文本、账单、价目表、截图里的文字）落成 pi 的计费配置。

## 前置条件

**必须先让用户执行 `/price ai` 启用 AI 编辑模式**（本次会话内有效）。
未启用时 `price_*` 工具不在可用工具列表中；如果调用返回"未启用"提示，
说明用户还没执行 `/price ai`，请明确告诉用户先执行该命令，不要自己想办法绕过。

## 硬性禁止

- **禁止**用 `edit` / `write` / `bash` 直接修改 `~/.pi/model-pricing.json`。
  直接改文件会绕过校验和引用保护，可能让配置进入损坏状态。
  所有改动一律走 `price_apply`。
- **禁止猜测**。价格、日期、时段、星期、时区、模型名、厂商名——任何一项资料里
  没写清楚，都要问用户，不要填一个"看起来合理"的值。
- **禁止**在用户没确认前调用 `price_save` 之外的落盘手段。落盘只能通过 `price_save`。

## 工作流

1. **读现状**：调用 `price_get`，看清现有的价格实体、方案、规则、日历、模型绑定。
   注意现有 id 命名习惯（如 `ds-v4-pro-peak`），新增时保持一致风格。
2. **解析资料**：把用户给的资料整理成结构化字段——厂商、模型名、价格数值、
   适用时间条件。单位统一为 **¥ / 百万 token**；如果资料是别的单位（如 ¥/千 token），
   先换算并告知用户换算结果。
3. **补齐缺失信息**：资料里没有的（时区、星期、节假日日历等）问用户，不要默认。
   只有时区可以合理默认 `Asia/Shanghai`，但也要在报告中说明。
4. **应用改动**：调用 `price_apply`，传一组语义动作。先建被引用的实体
   （价格实体 / 日历），再建方案，最后做绑定——因为方案规则会引用价格和日历。
5. **让用户确认**：调用 `price_review`，把改动预览展示给用户。
6. **落盘**：用户看过之后调用 `price_save`。首次保存会弹确认框，属正常流程。
   保存被拒绝时（引用不存在的价格/日历等），按返回原因修正后重试，不要强行落盘。
7. **报告**：告诉用户改了哪几个实体（价格/方案/规则/绑定/日历），以及落盘结果。

## 格式规范

| 字段 | 格式 | 说明 |
|---|---|---|
| 价格 | number | ¥/百万 token，非负 |
| 日期（日历） | `YYYY-MM-DD` 或 `MM-DD` | `MM-DD` = 每年循环（节假日用这个） |
| 日期（有效期/指定/排除） | `YYYY-MM-DD` | 精确日期 |
| 时段 | `["HH:MM", "HH:MM"]` | 半开区间，含头不含尾；跨天拆成两段 |
| 星期 | 1–7 | 1=周一 … 7=周日；空数组 = 任意星期 |
| 时区 | IANA 名 | 如 `Asia/Shanghai` |

**空 weekdays + 空 ranges = 永远匹配（基准价）**。规则数组顺序 = 优先级，先匹配先生效。

## 常见场景

### 场景一：改某模型的峰/谷价

资料："deepseek-v4-pro 高峰（工作日 9-12、14-18）输入 27 / 输出 54，
其余时间输入 13.5 / 输出 27，缓存命中均为输入价的一半"

```
1. price_get → 看现有 deepseek 的模型与方案绑定
2. price_apply:
   - upsertPrice  ds-v4-pro-peak   { inputMiss: 27, output: 54, inputHit: 13.5 }
   - upsertPrice  ds-v4-pro-off    { inputMiss: 13.5, output: 27, inputHit: 6.75 }
   - upsertPlan   ds-v4-pro        { rules: [
       { price: "ds-v4-pro-peak", weekdays: [1,2,3,4,5], ranges: [["09:00","12:00"],["14:00","18:00"]] },
       { price: "ds-v4-pro-off" }   // 兜底：空 conditions = 永远匹配
     ] }
   - bindModel    deepseek / deepseek-v4-pro → ds-v4-pro
3. price_review → 给用户看
4. price_save
```

### 场景二：加一个节假日日历，并让高峰规则在节假日失效

资料："中国法定节假日：元旦 1-1，国庆 10-1 到 10-7"

```
1. price_apply:
   - upsertCalendar cn-holiday { name: "中国法定节假日",
       dates: ["01-01", "10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07"] }
2. price_get 找到需要引用它的方案与规则下标
3. price_apply:
   - upsertPlan（或 setRulePrice 前先看现规则）
     把该规则 schedule 设为 { ..., calendar: "cn-holiday", calendarMode: "exclude" }
4. price_review → price_save
```

引用日历时必须同时给 `calendar` 和 `calendarMode`（`include` = 仅这些日期生效；
`exclude` = 这些日期不生效）。

## 出错时怎么办

`price_apply` 返回的失败项会带原因（如"价格实体 X 不存在"）。常见自纠：

- **引用的实体不存在**：先创建它，或在同一批动作里把它排在引用者之前。
- **模型/厂商不存在**：确认用户的模型名与配置里的 key 是否一致；
  不一致就问用户，不要新建厂商条目来"接住"错名字。
- **保存被拒（引用完整性）**：说明某个方案/规则引用了不存在的价格或日历，
  按原因补建或改正引用后重试。

任何一步不确定，停下来问用户。宁可少改，不可乱改。
