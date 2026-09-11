# pi-pricer

**Pi 的模型计费配置中心：价格不再是硬编码，而是一份你随时能改、全扩展共享的数据。**

一句话：把「各扩展各自写死一份价表、厂商一调价就得发版」的痛，换成「一份 `~/.pi/model-pricing.json`，`/price` 打开就能看、就能改、改完全扩展立刻生效」。

---

## 为什么需要它

如果你是 Pi 重度用户，下面三个场景你大概率经历过：

| 痛点 | 现状 | 用 pi-pricer 之后 |
|---|---|---|
| **厂商调价** | 价表硬编码在扩展源码里，每次调价都等发版 | 一条命令改数字，所有扩展立刻读到新价 |
| **多扩展各算各的** | pi-prompt、pi-usage 各自维护价表，口径不一致、对不上账 | 一份数据源，谁调谁消费，账永远对得上 |
| **峰谷/节假日算错账** | 高峰低谷、促销日、法定节假日套不进死价表 | 按星期 × 时段 × 日历自由组合，命中最高优先级规则 |

它不是"又一个命令行工具"，而是 **Pi 生态的价格基础设施**——上游是配置数据，下游是所有需要计价的功能。

---

## 开箱你能得到什么

- **一个真正的价格管理后台**：`/price` 打开可视化抽屉，厂商 → 模型 → 方案逐层下钻，改价、增删方案、管理日历，不用碰任何文件格式。
- **全天候计费规则引擎**：时段（峰谷）、每周循环、日历节假日、指定/排除日期、规则有效期，first-match-wins 按优先级命中。
- **改价即生效**：所有编辑先落内存草稿，`Ctrl+S` 一键保存，`Ctrl+R` 一键丢弃，绝不留脏数据。
- **填错不生气**：每个输入弹窗都带格式脚注与就地校验——填错了弹窗不关、输入不丢，当场告诉你哪填错了。
- **跨扩展共享 API**：`@foolsecret/pi-pricer/pricing` 一行导入，批量查询闭包复用，一次读盘。
- **零迁移负担**：旧版配置读取时自动升级到 v2 模型，峰谷语义保持不变。

---

## 快速开始（30 秒）

```bash
# 1. 安装（一条命令）
pi extension add @foolsecret/pi-pricer

# 2. 打开价格面板，看看现网价是不是你实际付费的价
/price

# 3. 发现某模型价不对？下钻到该模型，改掉，Ctrl+S 保存
#    其他地方（pi-prompt 对账、pi-usage 成本统计）立刻用上新价

# 4. 不想开面板？一条命令看实时价
/price model deepseek deepseek-flash
```

首次启动会自动写入一份内置默认价表（基于实测账单校准），开箱即可用。

---

## 一份价格，全生态生效

```
        ~/.pi/model-pricing.json（你维护，唯一事实源）
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   /price 面板    pi-prompt       pi-usage
   （编辑入口）   （会话对账）    （成本统计）
        │                              ▲
        └────  resolvePricing() ──────┘
              （/pricing 子路径导出）
```

---

## 计费场景，怎么配

| 场景 | 做法 |
|---|---|
| **高峰 vs 低谷** | 建两个规则：`weekdays:[1-5] + ranges:["09:00","12:00")` 走峰价，其余走谷价 |
| **法定节假日** | 配置里挂一个 `calendar`（如 `01-01`、`10-01`），规则设为「日历内命中」或「日历内排除」 |
| **促销日 / 大促** | `includeDates` 直接写 `2026-11-11`，当天命中促销价，平时不受影响 |
| **规则到期下线** | `validUntil` 写截止日期，过期自动不参与匹配，无需手动清理 |
| **多模型共用方案** | 价格实体独立建在注册表里，N 个模型引用同一个 `price`，改一处全生效 |

规则叠加不用担心打架——**绑定数组顺序即优先级，第一个命中的规则生效**（first-match-wins）。基准价档（全天任意命中）永远兜底，绝对不会"查不到价就报错"。

---

## 命令速查

| 命令 | 干嘛的 |
|---|---|
| `/price` | 打开价格面板（模型与绑定）；无 TUI 时输出文本总览 |
| `/price list` | 全量总览：所有厂商 / 模型 / 实时价 |
| `/price model <provider> <model>` | 单模型详情：当前生效哪些档、实时价是多少 |
| `/price scheme` | 方案管理：规则、时段、有效期、日历引用 |
| `/price rate` | 价格注册表：不同模型共享的价格实体 |
| `/price calendar` | 日历管理：节假日 / 特殊日期 |
| `/price help` | 完整帮助 |

> 支持 **Tab 补全**：`/price ` 后列出子命令，继续输入会补全配置里真实存在的方案/价格/日历/模型 id。
> 只读页（list / help / 模型详情）在 TUI 下以可滚动 Markdown 呈现，headless 环境自动回退纯文本。
> 价格、方案、日历的**编辑**都在面板里完成，不向外暴露臃肿的命令参数。

---

## 数据长什么样

配置文件位于 `~/.pi/model-pricing.json`，五张注册表彼此独立、可以互相引用：

```jsonc
{
  "version": 2,
  "calendars": { "cn-holidays": { "name": "中国节假日", "dates": ["01-01", "10-01"] } },
  "prices": {
    "deepseek-valley": { "name": "全时谷价", "input": { "miss": 1, "hit": 0.02 }, "output": 4 }
  },
  "plans": {
    "valley-plan": {
      "name": "谷价方案",
      "rules": [{ "schedule": { "timezone": "Asia/Shanghai", "weekdays": [], "ranges": [] }, "price": "deepseek-valley" }]
    }
  },
  "providers": {
    "deepseek": {
      "models": {
        "deepseek-flash": { "alias": "deepseek-v4-flash", "plans": [{ "plan": "valley-plan", "enabled": true }] }
      }
    }
  }
}
```

- 价格单位统一为 **¥ / 百万 token**（输入 miss / hit 与输出价同口径）。
- 方案内的 `schedule` 可组合：`timezone`、`weekdays`（1=周一…7=周日，空=任意）、`ranges`（半开时段 `["09:00","12:00")`，空=全天）、`calendar` + `calendarMode`（include 仅这些 / exclude 剔除）、`includeDates` / `excludeDates`、`validUntil`（规则截止）。
- `weekdays` 与 `ranges` 同时为空 = 该规则永远命中（做基准价档）。

> 不想手写？**面板里全都能改**。这个文件只是给要调试/备份/交接的人看的。

---

## 扩展开发者接入

```ts
import { resolvePricing, createPricingResolver } from "@foolsecret/pi-pricer/pricing";

// 单次查询：此刻这条模型多少钱
const price = resolvePricing("deepseek-flash", "deepseek", new Date());

// 批量查询（推荐）：一次读盘，返回可复用闭包，逐条调价零磁盘 IO
const resolve = createPricingResolver();
const p1 = resolve("deepseek-flash", "deepseek", Date.now());
const p2 = resolve("deepseek-v4-pro", "deepseek", Date.now());
```

导出子路径：`/pricing`（查询）、`/store`（存储）、`/types`（类型）。查询结果含 `output` / `inputMiss` / `inputHit`，自动按时间判断峰谷与日历命中，无序自研。

---

## 常见问题

**改了价要重启 Pi 吗？** 不用。保存即写盘，查询时实时读取。

**多扩展会互相覆盖价格吗？** 不会。价格只在一个地方维护（这份 JSON），扩展只读不写。

**旧的 v1 配置还能用吗？** 能。读取时自动迁移到 v2，峰谷语义保持一致，无需手动转换。

**没有 TUI（SSH / CI）怎么办？** 自动回退纯文本输出，命令照常可用；批量查询接口与界面无关。

**谁在生产环境用了它？** 作者自己的 pi-prompt 会话对账已接入（通过动态 import + 兜底），本地 115 项自动测试覆盖全链路。

---

## License

GNU Affero General Public License v3.0（AGPL-3.0）。

选择一个对等贡献的协议，是想说清一件事：**好东西可以随便拿去用，但用了我们的努力，也请把你的这份改进回流给所有人。**

简单说，遵守三条，你随便用：

1. **能用**：安装、运行、接入你自己的 Pi，完全免费。
2. **要开源**：如果你修改或再分发这个扩展（包括把它嵌入你自己的闭源产品、做成网络服务对外提供），必须把改动以同样协议（AGPL-3.0）开源、保留版权声明、说明修改点——和别人的贡献一起共享出来。
3. **给回馈**：把好改动提交回来，让整个生态都变好。

> 法律上这是 AGPL-3.0 的标准义务（含第 13 条"通过网络提供服务亦视为分发"）。商业/闭源使用请先与作者确认豁免条款。