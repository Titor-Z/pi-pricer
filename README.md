# pi-pricer

**Pi 的模型计费配置中心** — Model pricing config & rules engine for Pi extensions.

只管规则：价格、日历、规则、方案、模型绑定。
不展示"当前什么价"——那是消费方（pi-usager、pi-prompt）的事；pi-pricer 把结构化结果透传出去。

一句话：把「各扩展各自写死一份价表、厂商一调价就得发版」的痛，换成
「一份 `~/.pi/model-pricing.json`，用 `/price` 管理，改完全扩展立刻生效」。

---

## 为什么需要它

| 痛点 | 现状 | 用 pi-pricer 之后 |
|---|---|---|
| **厂商调价** | 价表硬编码在扩展源码里，每次调价都等发版 | 改一处价格，所有扩展立刻读到 |
| **多扩展各算各的** | pi-prompt、pi-usager 各自维护价表，口径对不上 | 一份数据源，谁调谁消费 |
| **峰谷 / 节假日算错账** | 高峰低谷、促销日、法定节假日套不进死价表 | 按星期 × 时段 × 日历组合，规则按创建先后覆盖 |

---

## 开箱你能得到什么

- **一个可视化价格面板**：`/price` 打开抽屉，模型 → 方案逐层下钻；价格 / 日历 / 规则 / 方案四张表在面板里直接增删改（`Ctrl+S` 保存、`Ctrl+R` 重置）。
- **六条命令，五脏俱全**：价格、日历、规则、方案、模型绑定全部可管理；无 TUI 时自动回退文本。
- **数据库式的数据模型**：五个集合靠 `_id` 互相引用，跨表 join；一份 JSON 模拟一套 Mongo。
- **事务化写入**：校验 + 乐观锁 + 原子提交，失败整笔回滚，不留"改一半"的脏数据。
- **规则组合引擎**：时段、周循环、日历（包含 / 排除）、指定 / 排除日期、规则有效期，后创建覆盖先创建。
- **AI 辅助配置（可选）**：把价目表 / 账单丢给 agent，它读现状、补缺失、提交改动，落盘前你确认。
- **跨扩展共享 API**：`@foolsecret/pi-pricer/pricing` 一行导入，批量查询闭包复用。

---

## 快速开始（30 秒）

```bash
# 1. 安装
pi extension add @foolsecret/pi-pricer

# 2. 看看现在配了哪些模型 → 方案
/price

# 3. 改一个价格
/price rate set "DeepSeek 谷价" output 4

# 4. 看价格表 / 方案表
/price rate
/price plan
```

首次启动会自动写入一份内置默认价表（基于实测账单校准），开箱即可用。

---

## 命令速查

| 命令 | 作用 |
|---|---|
| `/price` | 打开价格面板（TUI），列出已设定方案的模型；无 TUI 时输出文本列表 |
| `/price rate` | 打开面板直达价格表（或文本：`list` / `add` / `set` / `remove`） |
| `/price calendar` | 打开面板直达日历表（或文本：`list` / `add` / `add-dates` / `remove`） |
| `/price rule` | 打开面板直达规则表（或文本：`list` / `add` / `remove`） |
| `/price plan` | 打开面板直达方案表（或文本：`list` / `add` / `set-alias` / `add-rule` / `remove-rule` / `enable` / `disable` / `bind` / `remove`） |
| `/price ai` | 会话级启用 AI 编辑模式：`on` / `off` |

- **面板键位**：`↑↓` 移动 · `Enter` 执行 · `Esc` 返回 · `Ctrl+S` 保存 · `Ctrl+R` 重置；长列表用 `PgUp/PgDn` 翻页。输入也是子页（无弹窗），就地校验，填错不离页、不丢输入。
- 带二级动作（如 `/price rate add "促销价" 0.5 0.01 2`）不开面板，走文本执行，便于脚本化。
- 名称含空格用引号：`/price rate add "促销价" 0.5 0.01 2`
- 规则选项：`--weekdays 1-5`、`--ranges 09:00-12:00,14:00-18:00`、`--include-cal "中国法定节假日"`、`--exclude-cal …`、`--include-dates …`、`--exclude-dates …`、`--valid-until 2026-12-31`、`--timezone Asia/Shanghai`
- 支持 **Tab 补全**：子命令 → 动作 → 配置里真实存在的 name（含空格自动加引号）

---

## 面板长什么样

**面包屑导航**：标题行是页面栈的标题链，末级高亮，超宽时从最左（最老）祖先开始折叠、`…` 表示省略，
**当前位置永不隐藏**：

```
  模型 › 规则 › DeepSeek 工作日高峰 › 编辑星期
```

**统一导航**：所有编辑都是压栈子页（选择 / 编辑 / 切换 / 重命名 / 确认删除），没有弹窗；
只有当场可判定的单一开关（方案启用/禁用）就地生效。面包屑始终回答"我在第几层"。

**两种列表布局**：

- 行式（默认）：多列对齐，模型列表、价格表、日历表、方案表用它
  ```
  ▶ deepseek-v4-pro@deepseek  → [deepseek-v4-pro 方案@Pro 默认]  [启用]
  ```
- 卡片式：规则表用它 —— 条目两行 + 条目间空行，规则名不再被时间列挤窄
  ```
  ▶ DeepSeek 工作日高峰
    → DeepSeek 峰价 · 周一二三四五 · 09:00-12:00/14:00-18:00
  ```

**分页**：检索模型 8 条/页、规则表 4 条/页；页码（`第 x/y 页`）画在列表下方；
末尾的 `＋新建…` 动作条不参与分页、常驻在页码下面，光标可以下移到它。

---

## 数据长什么样

配置文件 `~/.pi/model-pricing.json`，五个集合，document 之间用 `_id` 引用：

```jsonc
{
  "version": 5,
  "rates": [
    { "_id": "084160217307451e", "createdAt": "2026-09-10T00:00:01.000Z",
      "name": "DeepSeek 谷价", "inputMiss": 1, "inputHit": 0.02, "output": 4 }
  ],
  "calendars": [
    { "_id": "366c21606bf01df0", "createdAt": "…",
      "name": "中国法定节假日", "dates": ["01-01", "10-01", "10-02"] }
  ],
  "rules": [
    { "_id": "…", "createdAt": "…", "name": "DeepSeek 全时谷价", "rateId": "084160217307451e",
      "timezone": "Asia/Shanghai", "weekdays": [], "ranges": [],
      "includeCalendars": [], "excludeCalendars": [], "includeDates": [], "excludeDates": [] },
    { "_id": "…", "createdAt": "…", "name": "DeepSeek 工作日高峰", "rateId": "…",
      "weekdays": [1,2,3,4,5], "ranges": [["09:00","12:00"],["14:00","18:00"]], "…": "…" }
  ],
  "plans": [
    { "_id": "…", "createdAt": "…", "name": "deepseek-flash 方案", "alias": "Flash 默认",
      "enabled": true, "ruleIds": ["…", "…"] }
  ],
  "models": [
    { "_id": "…", "createdAt": "…", "provider": "deepseek", "model": "deepseek-flash", "planId": "…" }
  ]
}
```

- 价格单位统一 **¥ / 百万 token**。
- `_id` 是 16 位十六进制（不可读），人与命令行用各表 `name`（唯一）定位。
- **规则优先级 = `createdAt`：后创建覆盖先创建**。所以先建兜底（全时）规则，再建特例（峰时段）规则。
- 模型 → 方案是单值绑定；方案可禁用（禁用后该模型走兜底价）。

---

## 计费场景，怎么配

| 场景 | 做法 |
|---|---|
| **高峰 vs 低谷** | 建两条规则：先建"全时谷价"，后建"工作日 09:00-12:00 / 14:00-18:00 峰价"——特例覆盖兜底 |
| **法定节假日不按峰价** | 建日历"中国法定节假日"，峰规则加 `--exclude-cal "中国法定节假日"` |
| **促销日专属低价** | 建日历"促销日"（如 `2026-11-11`），后建规则 `--include-cal "促销日"` |
| **规则到期下线** | 规则加 `--valid-until 2026-12-31`，过期自动不参与匹配 |
| **多模型共用方案** | 一个 plan 可被多个 model 绑定；规则/价格复用，改一处全生效 |

规则匹配是**条件的交集**（星期、时段、日历、日期全部成立才命中）；
规则之间是**后创建覆盖先创建**——交集处覆盖，互不影响处各自生效。

---

## 懒得手填？让 AI 帮你配

```bash
/price ai        # 本次会话内允许 agent 修改计费配置
# 然后直接说：
#   “deepseek-v4-pro 高峰输入 27 输出 54，其余时间 13.5 / 27，帮我改掉”
```

- **必须手动启用**：没执行 `/price ai` 时，相关工具对模型完全不可见、调不到。
- **改动先进草稿**：agent 只能提交结构化动作；一批动作整批原子，任一失败整批回滚。
- **落盘前校验 + 确认**：引用完整性、名称唯一、乐观锁都在提交时检查。
- 附带的 `price-config` skill 教 agent 工作流（读现状 → 解析资料 → 补缺失 → 应用 → 确认 → 落盘），信息不全时来问你，而不是猜。

---

## 扩展开发者接入

```ts
import { resolvePricing, createPricingResolver } from "@foolsecret/pi-pricer/pricing";

// 单次查询：此刻这条模型多少钱
const price = resolvePricing("deepseek-flash", "deepseek", new Date());
// → { inputMiss, inputHit, output, isPeak, planId?, planName?, planAlias?, rateId?, ruleId? }

// 批量查询（推荐）：一次读盘，返回可复用闭包
const resolve = createPricingResolver();
const p1 = resolve("deepseek-flash", "deepseek", Date.now());
const p2 = resolve("deepseek-v4-pro", "deepseek", Date.now());
```

导出子路径：`/pricing`（查询）、`/store`（存储）、`/types`（类型）、`/db`（事务化 DAO）。

---

## 版本与协同发布（重要）

- 本版为 **v0.14.0**（Schema v5，文档模型 + 事务化 DAO + TUI 编辑面）。
- **v5 与旧结构（≤ 0.12）不兼容**：旧扩展若直接读 JSON 字段会失配，消费方必须升级到适配 v5 的版本。
- **发布必须协同**：pi-pricer 与消费方（pi-usager 等）**要一起发**。仅升级 pi-pricer 而不升级消费方，
  会出现"读到新结构但按旧契约解析"的问题。配对版本号以 pi-usager 仓库的发布说明为准。
- **推送 tag = 发版**：`git push origin v0.14.0` 会触发 GitHub Actions（`.github/workflows/release.yml`）执行
  `npm run prepublishOnly` + `npm publish`。因此**本地可以先打 tag，但不要单独推 tag**——等消费方版本就绪后再推。
- 维护者发布检查清单：
  1. 消费方（pi-usager 等）已依赖并适配本次版本，且其自测全绿；
  2. 本仓库 `npm run prepublishOnly`（typecheck + test）全绿；
  3. 先推分支 `git push origin main`，再推 tag `git push origin v0.14.0`；
  4. 发布后核对 npm registry 版本与消费方 `peerDependencies` 范围。

---

## 常见问题

**改了价要重启 Pi 吗？** 不用。保存即写盘，查询时实时读取。

**多个扩展会互相覆盖价格吗？** 不会。价格只在这一份 JSON 里维护，扩展只读。

**旧版配置还能用吗？** 不能直接沿用：v5 与旧结构不兼容。读到旧文件时会以 v5 内置种子运行（**不改写你的旧文件**），你保存时才写成 v5。

**没有 TUI（SSH / CI）怎么办？** 命令面本身就是文本输出，照常可用。

**为什么看不到"当前价格"？** pi-pricer 只做规则的制定与管理；要查当前价请用消费方（如 pi-usager 的 `/usage status`）。

---

## License

GNU Affero General Public License v3.0（AGPL-3.0）。

简单说，遵守三条，你随便用：

1. **能用**：安装、运行、接入你自己的 Pi，完全免费。
2. **要开源**：修改或再分发（含嵌入闭源产品、做成网络服务对外提供），必须把改动以同样协议开源、保留版权声明、说明修改点。
3. **给回馈**：把好改动提交回来，让整个生态都变好。

> 法律上这是 AGPL-3.0 的标准义务（含第 13 条"通过网络提供服务亦视为分发"）。商业/闭源使用请先与作者确认豁免条款。
