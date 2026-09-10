# pi-pricer

Pi 模型计费配置中心 — 让模型价格成为**可编辑的数据**，而不是硬编码在扩展源码里。

pi-pricer 拥有 `~/.pi/model-pricing.json` 的数据主权，向其他 Pi 扩展（pi-prompt、pi-usage 等）
提供统一的 `resolvePricing()` 查询接口；厂商调价时只需改一条命令，无需等待扩展发版。

## 特性

- **五注册表原子计费模型**（Schema v2）：`calendars` / `prices` / `plans` / `providers` 各自独立，规则可复用
- **first-match-wins 解析**：绑定数组顺序即优先级，命中最高优先级规则即返回
- **时段 / 周循环 / 日历 / 特定日期**：覆盖峰谷、工作日、节假日、促销日等计费场景
- **TUI 钻取抽屉**：`/price` 无参打开三级钻取（厂商 → 模型 → 详情）
- **v1 自动迁移**：读取旧版文件时内存自动升级为 v2，无需手动转换
- **跨扩展共享**：`@foolsecret/pi-pricer/pricing` 子路径导出批量解析器

## 安装

```bash
pi extension add @foolsecret/pi-pricer
```

或作为本地依赖：

```bash
npm install file:../pi-pricer
```

## 命令

| 命令 | 说明 |
|---|---|
| `/price` | 无参打开钻取抽屉（TUI）；无 TUI 时输出文本总览 |
| `/price list` | 文本总览（厂商 / 模型 / 实时价） |
| `/price model <provider> <model>` | 单模型详情（绑定方案 + 实时生效价） |
| `/price plan [<plan-id>]` | 方案清单 / 单个方案详情 |
| `/price price [set <id> <field> <value>]` | 价格注册表 / 修改价格实体 |
| `/price calendar` | 日历注册表 |
| `/price resolve <model> [provider] [YYYY-MM-DDTHH:mm]` | 调试解析链（显示命中/未命中及原因） |
| `/price bind <provider> <model> <plan-id>` | 绑定方案（追加到末尾 = 最低优先级） |
| `/price unbind <provider> <model> <plan-id>` | 解除绑定 |
| `/price schema` | Schema 格式说明 |
| `/price help` | 帮助 |

## 数据文件

`~/.pi/model-pricing.json`（首次启动自动写入内置默认值）。

```jsonc
{
  "version": 2,
  "calendars": { "cn-holidays": { "name": "中国法定节假日", "dates": ["01-01", "10-01"] } },
  "prices": {
    "deepseek-valley": {
      "name": "DeepSeek 谷价",
      "input": { "miss": 1, "hit": 0.02 },
      "output": 4
    }
  },
  "plans": {
    "deepseek-valley-plan": {
      "name": "全时谷价",
      "rules": [
        { "schedule": { "timezone": "Asia/Shanghai", "weekdays": [], "ranges": [] }, "price": "deepseek-valley" }
      ]
    }
  },
  "providers": {
    "deepseek": {
      "models": {
        "deepseek-flash": { "alias": "deepseek-v4-flash", "plans": [{ "plan": "deepseek-valley-plan", "enabled": true }] }
      }
    }
  }
}
```

价格单位统一为 **¥ / 百万 token**。

### Schedule 字段

| 字段 | 说明 |
|---|---|
| `timezone` | IANA 时区名（如 `Asia/Shanghai`） |
| `weekdays` | 星期（1=周一 … 7=周日）；空数组 = 任意星期 |
| `ranges` | 时段 `["HH:MM", "HH:MM")` 半开区间；空数组 = 全天 |
| `calendar` / `calendarMode` | 日历引用；`include` 仅这些日期 / `exclude` 剔除 |
| `includeDates` | 具体日期命中（`YYYY-MM-DD` 或 `MM-DD`） |
| `excludeDates` | 具体日期排除 |
| `validUntil`（规则级） | 规则截止日期，过期不参与匹配 |

> `weekdays` 与 `ranges` 同时为空 = 永远匹配（基准价）。

## 跨扩展调用

```ts
import { resolvePricing, createPricingResolver } from "@foolsecret/pi-pricer/pricing";

// 单次查询
const price = resolvePricing("deepseek-flash", "deepseek", new Date());

// 批量查询（一次读盘，闭包复用）
const resolve = createPricingResolver();
const p = resolve("deepseek-flash", "deepseek", Date.now());
```

导出子路径：`/pricing`（查询）、`/store`（存储）、`/types`（类型）。

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # node --test
```

## License

MIT
