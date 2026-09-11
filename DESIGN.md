---
version: alpha
name: pi-pricer Model Pricing Config
description: 模型计费配置中心的 UI/UX 设计规范与可复用模块切分。定义 /price 命令的三级钻取交互、JSON 数据契约、以及跨扩展共享的价格解析 API。
colors:
  accent: accent
  border-accent: borderAccent
omitted:
  - section: typography
    reason: "终端 TUI：字体随用户终端主题"
  - section: spacing
    reason: "行距/缩进由 SettingsList 布局决定"
  - section: rounded
    reason: "终端无圆角"
  - section: elevation
    reason: "TUI 用边框分隔层级"
components:
  shell:
    shellBorder: "{colors.border-accent}"
    titleText: "{colors.accent}"
    titleWeight: bold
  command-completion:
    # 渲染归属：pi-tui 的 Editor + SelectList（pi-pricer 只提供候选数据，不自绘）
    renderer: pi-tui Editor / SelectList
    selectedPrefix: "{colors.accent}"
    selectedText: "{colors.accent}"
    description: "{colors.dim}"
    scrollInfo: "{colors.dim}"
    noMatch: "{colors.dim}"
---

# pi-pricer Model Pricing Config

Pi 生态的模型计费数据共享中心。解决"厂商调价频繁，硬编码价表跟不上"的问题：
将价格数据从代码中抽离为 `~/.pi/model-pricing.json`，由 pi-pricer 拥有数据主权 + 
提供编辑 UI，pi-prompt / pi-usage / 未来组件统一消费同一份 JSON。

## Overview

产品人格是**数据优先 + 就地可编辑**：一切价格数据来自 JSON 文件，UI 既是浏览层
也是编辑层。用户在抽屉内直接启停绑定、改价格实体、增删方案；所有编辑先写内存
（PricingDraft），`Ctrl+S` 一次性全量落盘，`Ctrl+R` 丢弃未保存改动。

交互层级：`/price` → Provider 列表 → Model 列表 → Model 详情（可编辑菜单）
→ 绑定操作页。第 0 级尾部另有三个管理面入口：方案 / 价格 / 日历注册表。

情绪响应：透明、可预期。状态栏常驻显示 `● 未保存改动（面）` / `✓ 已保存`，
用户随时知道改动是否落盘；保存被引用保护拒绝时只提示原因，不退出编辑器。

## Colors

继承 pi Theme（与 pi-prompt 抽屉一致）：
- **Accent**：标题 + 当前选中值
- **Border Accent**：上下 DynamicBorder 边框

## Components

### Shell（三级钻取容器 + 编辑会话）
- 双 DynamicBorder accent 边框（上进下出）
- 标题文本随层级变化："模型计费配置 · 厂商" → "· <provider>" → "· <provider>/<model>"
  → "· 方案/<plan-id>"
- 底部状态栏（Text）：`● 未保存改动（面）` / `✓ 已保存` + 保存结果 + 键位提示
- 持有 `PricingDraft` 内存会话；`Ctrl+S`/`Ctrl+R` 在当前层拦截
- Esc 回退层级 / 关闭；根层 Esc + 未保存时先提示如何处置

### Provider List（Level 0，默认根层）
- SettingsList 展示所有厂商，**仅此一类内容**
- 每行：`<provider-id>  (<N>模型 · <方案摘要>)`
- Enter → 下钻 Model List
- 管理面（方案/价格/日历）**不再挂在根层**：根层职责单一（只看"谁的模型"），
  管理面由子命令直达（`/price scheme|rate|calendar`）
- 实现：每行 SettingItem 带 `submenu`，Enter 用 SettingsList 原生 submenu 机制
  打开第 1 级；标题 Text.setText 随层级更新

### 直达管理页（initialPage）
`open(ctx, page)` 支持 4 个初始页，对应 CLI 子命令：

| page | CLI | 根标题 | 内容 |
|---|---|---|---|
| `models`（默认） | `/price` | `· 厂商` | 厂商列表 |
| `scheme` | `/price scheme` | `· 方案` | 方案注册表 |
| `rate` | `/price rate` | `· 价格` | 价格注册表 |
| `calendar` | `/price calendar` | `· 日历` | 日历注册表 |

- 直达页的 `depth` 初始为 1：**Esc 一次即退出**，不弹回无关的模型列表
  （用户是有意打开该管理页的）
- 保存/重置后的 `rebuildRoot()` 按初始页重建，不会跳回模型列表

### 命名决策（v0.7）
原 `plan` / `price` 子命令改名，理由：

| 旧 | 新 | 理由 |
|---|---|---|
| `/price plan` | `/price scheme` | `plan` 在英文里首先是动词"计划"，与中文语义"方案"不对应 |
| `/price price` | `/price rate` | `/price price set` 三处重复 price，读起来像结巴 |

### Model List（Level 1）
- SettingsList 展示当前厂商下的所有模型
- 每行：`<model-id>  <启用数>/<绑定数> 档启用 · aka <alias>`
- Enter → 下钻 Model Detail；Esc → 返回 Provider List

### Model Detail（Level 2，可编辑菜单）
- SettingsList 菜单页，逐项带 `submenu`：
  - 每条绑定一行：`#N ◉/◌ <方案名>`（`#N` = 优先级序号，首个标 `← 先匹配`），
    说明栏列出该方案规则时段 + "排序用 /price move"
  - `＋ 绑定新方案`（仅在存在未绑定方案时显示）
  - `别名（台账匹配）` → ExtensionInputComponent 覆盖层输入
  - `解析调试（预演某时刻命中链）` → ActionMenu（`此刻` / `指定时间…`）
    → 只读命中链页（`renderResolveResult`）
  - `查看只读详情` → 只读文本页（`renderModelDetail`）

### Binding Actions（Level 3）
- **ActionMenu 自绘菜单**（不用 SettingsList，原因见下）：
  - `禁用该绑定 / 启用该绑定`（软停用，不删除）
  - `解除绑定`
- 执行后回写 draft，回退至 Model Detail，状态栏提示"（Ctrl+S 保存）"

### Registry Pages（管理面）
- **方案注册表**：首项为人 `＋ 新建方案`（输入 id，默认挂首个价格实体的
  always 规则）；每方案 → 规则列表（改价格引用 / 有效期）
  + `方案操作（追加规则 / 复制 / 删除）`
- **价格注册表**：首项 `＋ 新建价格实体`（初值 0）；
  每个价格实体 → 改 output / input.miss / input.hit / 删除
- **日历注册表**：首项 `＋ 新建日历`（两步输入：id → 逗号分隔日期）；
  每个日历 → 删除
- 删除均经 `validate()` 引用保护；保存失败只提示，不退出

### ActionMenu（为何不用 SettingsList）
`SettingsList` 的 `activateItem()` 仅对 `submenu` 项和 `values` 项生效；
**无 submenu / 无 values 的普通项按 Enter 是空操作**。因此"执行动作"类页面
（绑定启停、方案操作、价格字段、删除确认、新建输入）改用 `ActionMenu` 自绘菜单
（↑↓ 选择 / Enter 执行 / Esc 返回），行为可预期。

### Command Completion（命令参数补全）

> **渲染归属**：候选菜单由 **pi-tui 的 `Editor` + `SelectList`** 绘制（`editor.ts` 的
> `createAutocompleteList()`，使用 `SelectListTheme`）。pi-pricer **不自绘菜单**，
> 只实现 `getArgumentCompletions` 提供候选数据（`AutocompleteItem`）。
> 因此本节的颜色/布局均为 pi-tui 的，不是本项目的定制点。

**视觉示意**（`/price scheme` 后）：

```
  /price scheme
  ┌──────────────────────────────────────────────┐
  │ → create       新建方案（默认挂首个价格实体）  │   ← 选中行：accent + → 前缀
  │   duplicate    复制方案                       │
  │   delete       删除方案（被绑定时拒绝）        │
  └──────────────────────────────────────────────┘
```

**一行候选的结构**：`<selectedPrefix><label>` 左列 + `description` 右列，两列对齐；
未选中行无前缀。颜色 token 见 frontmatter 的 `command-completion`。

**候选行数**：由 pi-tui 的 `autocompleteMaxVisible` 限制，超出时显示滚动信息
（`scrollInfo`）；无候选时**不出现菜单**（不显示空壳）。

**触发与选中**：
- 在 `/price` 后输入空格触发；继续输入按前缀过滤（忽略大小写）
- `Tab` 或 `Enter` 选中；选中后当前 token 被替换为 `item.value`
- 高亮优先：精确匹配 > 前缀匹配 > 保持默认高亮（pi-tui `editor.ts` 的行为）

**候选文案规范**（新增子命令必须遵守）：

| 位置 | label | description | 例 |
|---|---|---|---|
| 一级子命令 | 子命令名 | 中文一句话说明（尽量 ≤ 20 字） | `scheme` / 方案管理：列表 / 详情 / 新建 / 复制 / 删除 |
| 二级动作 | 动作名 | 中文一句话说明 | `delete` / 删除方案（被绑定时拒绝） |
| 动态 id | 真实 id | 其显示名（或 `provider/model` 上下文） | `valleyalways` / 全时谷价 |

> 设计意图：用户**不用记 id**，也不用离开输入框查看配置；每一行都能自证含义。

### 临时页栈（pageStack）与输入覆盖层（overlay）

两套临时层分工明确、**互斥**：

| 机制 | 用途 | 开关方式 |
|---|---|---|
| `pageStack` | 只读页（如解析命中链） | 压栈渲染，Esc 出栈 |
| `overlay` | 输入层（如新方案 id） | `tui.showOverlay`，Esc 取消 |

- ActionMenu 之上需叠只读页时用 `pageStack`：顶层 `handleInput` 优先派发给栈顶，
  栈顶 Esc 触发 `popPage()`。
- overlay 打开期间 `hasOverlay()` 守卫会阻断底层（pageStack / rootList）的输入，
  避免同一按键双重处理。

### 输入覆盖层生命周期（askText）

**铁律：`onSubmit` 与 `onCancel` 两条路径都必须关闭覆盖层。**

```
askText(tui, title, placeholder, onSubmit, onCancel?)
  1. 关闭已有覆盖层（closeOverlay，防嵌套残留）
  2. new ExtensionInputComponent(title, ph,
       v => { closeOverlay(); onSubmit(v); },
       () => { closeOverlay(); onCancel?.(); },
       { tui })
  3. 接住 showOverlay 返回的 handle 存入 overlaySlot
```

- 漏接 handle 或不 hide → 按 Esc 后覆盖层永久残留（用户可见的"卡屏"）
- 取消语义：**不写入 draft**，仅提示"已取消"并回退一级
- 嵌套输入（日历两步：id → 日期）：开第二层前先关第一层；第二步取消 = 整体放弃，
  不留半创建状态（第一步不写入 draft）

## Interaction

### /price 命令面

| 命令 | 交互 | 用途 |
|---|---|---|
| `/price` | 无参 → 三级抽屉（TUI）/ list 文本（headless） | 默认浏览 + 编辑 |
| `/price list` | 文本输出 | 快速查看 |
| `/price model <p> <m>` | 文本详情 | 查看单模型 |
| `/price scheme [<id>]` | TUI 直达方案管理页 / 文本列表 | 方案管理 |
| `/price scheme create\|duplicate\|delete` | 命令行 | 方案 CRUD（headless 可用） |
| `/price rate [create\|set\|delete]` | 命令行 | 价格实体 CRUD |
| `/price calendar [add\|remove]` | 命令行 | 日历 CRUD |
| `/price bind <p> <m> <plan>` | 命令行 | 追加绑定（末尾=最低优先级） |
| `/price unbind <p> <m> <plan>` | 命令行 | 移除绑定 |
| `/price move <p> <m> <plan> <up\|down\|top\|bottom>` | 命令行 | **调整绑定优先级** |
| `/price resolve <m> [p] [ts]` | 文本命中链 | 调试 first-match |
| `/price schema` | 文本 schema 说明 | 手动编辑参考 |

### 键盘映射

抽屉内（与 pi-prompt /prompt config 一致，仅新增两个全局键）：

| 键 | 作用 |
|---|---|
| ↑/↓ | 移动光标 |
| Enter | 下钻 / 执行动作 |
| Esc | 返回上级；根层：第一次提示、**第二次丢弃并退出** |
| 键入 | 搜索过滤（带 `enableSearch` 的列表） |
| **Ctrl+S** | **全量保存草稿到 `~/.pi/model-pricing.json`** |
| **Ctrl+R** | **丢弃未保存改动（重读磁盘）** |

> `Ctrl+Z` 未采用：终端默认将其作为 SIGTSTP（挂起进程），不适合做撤销。
> 这些键在根层拦截（SettingsList 子菜单展开时会接管全部输入，详见 AGENTS.md 认知修正 6）。

### 草稿生命周期（PricingDraft）

```
构造 → readPricing 深拷贝进内存（与磁盘解耦）
  ↓ 用户操作（切换绑定/改价/增删方案...）
mutate* 方法只改内存 + 标记 changedAreas（isDirty = true）
  ↓
Ctrl+S → validate() 引用完整性校验
         ├─ 失败 → 返回 {ok:false, reason}，不落盘，状态栏显示原因
         └─ 成功 → writePricing 全量写盘，清空 changed
Ctrl+R → reset() 重新 readPricing，清空 changed
```

**为什么需要草稿层**：用户要求"先写内存、Ctrl+S 保存"；同时保证保存前统一跑
引用保护校验，避免删除被引用实体后文件进入脏状态。

**全量写回语义**：`save()` 写回整份 schema（与 `writePricing` 天然一致），
不做路径级 diff。

### 排序为何不在 TUI

绑定数组顺序即优先级，但 **TUI 抽屉不提供上下移**：`SettingsList` 不暴露
`selectedIndex` 且子菜单会接管输入，自建可重排列表成本高。排序由 CLI
`/price move` 承担，抽屉内绑定顺序以 `#N` 序号**只读展示**并在说明栏提示命令。

### 预演调试（为何需要 pageStack）

解析调试页要预演"某个未来时刻命中了哪档价"，其命中链只读页需要叠在
ActionMenu 之上而不丢失菜单上下文；因此引入 `pageStack`：顶层输入优先派发给
栈顶，栈顶 Esc 出栈回到 ActionMenu。

### 命令补全（getArgumentCompletions）

**外观与文案规范见 `## Components → Command Completion`**；本节只描述行为契约。

pi 为扩展命令生成候选**只读 `getArgumentCompletions`**；扩展无法设 `argumentHint`。
分层规则（`pricing-cli-spec.ts` 的 `args` 声明决定每列语义）：

| 已输入 | 候选 |
|---|---|
| 第 1 列 | 一级子命令（`PRICE_SUBCOMMANDS`，带中文说明） |
| 第 2 列 | 二级动作（scheme/rate/calendar/move） |
| 第 3+ 列 | 按位置语义读配置取真实 id：provider / model / plan / price / calendar / field / direction |

行为示例：
- `scheme delete ` → 方案 id（`peakworkday` / `valleyalways` / …）
- `bind deepseek deepseek-flash ` → **该模型已绑定**的宏方案优先
- `rate set peak ` → `input.miss` / `input.hit` / `output`
- `move … peakworkday ` → `up` / `down` / `top` / `bottom`

边界约定：
- 「末尾是否有空格」决定补当前 token 还是开新 token（最易写错处）
- 动态读取异常一律 try/catch 降级，**绝不抛出**（补全异常会破坏输入框）
- 无匹配返回 `null`（pi 约定）
- 单一数据源：dispatch / help / 补全三处同源，配一致性测试防漂移

### 无 TUI 回退

headless 模式下 `/price` 回退为 `list` 文本输出；所有编辑能力均有等价 CLI
（bind / unbind / move / plan / price / calendar），headless 可完整操作。

## Data Schema（JSON v1）

文件路径：`~/.pi/model-pricing.json`

```jsonc
{
  "version": 1,
  "providers": {
    "<provider-id>": {
      "peakHours": {
        "timezone": "Asia/Shanghai",
        "weekdays": [1, 2, 3, 4, 5],    // 1=周一 ... 7=周日
        "ranges": [[9, 12], [14, 18]]    // [start, end) 半开区间
      } | null,
      "models": {
        "<model-id>": {
          "alias": "<pi-内部名>",         // 可选，台账匹配用
          "input": { "miss": ¥/M, "hit": ¥/M },
          "output": { "standard": ¥/M, "peak": ¥/M | null }
        }
      }
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 缺省 | 说明 |
|---|---|---|---|---|
| `version` | `1` | ✓ | — | Schema 版本号（前向兼容） |
| `providers` | `Record<string, ProviderPricing>` | ✓ | — | 厂商列表 |
| `peakHours` | `PeakHours \| null` | ✓ | — | 峰时段规则（null=无峰） |
| `timezone` | `string` | ✓ | — | IANA 时区名 |
| `weekdays` | `number[]` | ✓ | — | 星期几（1-7） |
| `ranges` | `[number, number][]` | ✓ | — | 小时段 [start, end) |
| `models` | `Record<string, ModelPricing>` | ✓ | — | 模型列表 |
| `alias` | `string` | — | `undefined` | pi 内部 model 名别名 |
| `input.miss` | `number` | ✓ | — | 缓存未命中价（¥/百万 token） |
| `input.hit` | `number` | ✓ | — | 缓存命中价（¥/百万 token） |
| `output.standard` | `number` | ✓ | — | 空闲输出价（¥/百万 token） |
| `output.peak` | `number \| null` | — | `null` | 峰值输出价（null=无峰谷） |

### 存储与 Fallback 链

```
resolvePricing(model, provider, ts)
  → JSON 有该 model（含 alias 匹配）→ 用 JSON 价格（含峰谷）
  → JSON 没有 → 硬编码兜底 { miss:1, hit:0.02, output:4 }
```

## Data Schema（JSON v2）

v1 每个模型一份价格、厂商共享峰时段；v2 拆成**五注册表原子模型**，
让"时段 × 价格"可复用、可任意组合：

- **calendars**：节假日/特殊日期表（`dates` 支持 "YYYY-MM-DD" 精确日期 +
  "MM-DD" 每年循环），方案 schedule 通过 `calendar` + `calendarMode`（include/exclude）
  引用

#### CalendarEntry 字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | `string` | ✓ | 日历显示名（如 "中国法定节假日"） |
| `dates` | `string[]` | ✓ | 日期列表；每项为 `"YYYY-MM-DD"`（单年）或 `"MM-DD"`（每年循环） |

> 日历不含时段字段：时段约束属于 `Schedule.ranges`，日历只回答"这一天是否特殊"。
> 两者通过 `rules[].schedule.calendar` + `calendarMode` 组合。
- **prices**：价格实体（`input.miss/hit` + `output`），可被多个方案规则复用
- **plans**：命名方案（时段规则集合），`rules[].schedule` 定义生效时间窗，
  `rules[].price` 指向价格实体；规则支持 includeDates / excludeDates /
  validUntil（"YYYY-MM-DD"，到期自动停用）
- **providers → models**：模型 `plans[]` 绑定一个或多个方案
  （`enabled` 可浮点开关；数组**顺序即优先级**，首位优先）
- 统一 schedule：`timezone` + `weekdays`（1-7）+ `ranges`（[start,end) 半开，
  跨午夜拆两段）；`weekdays:[]` + `ranges:[]` + 无日历/日期 = **总是命中**（基准档）

### Resolution 契约

```
resolvePricing(model, provider, ts)
  → 过滤：绑定 enabled=false → 跳过；方案规则 validUntil 到期 → 跳过
  → 按绑定数组顺序逐方案：schedule 命中（日期/星期/时间窗）→ 该规则价格即结果
  → 全部未命中 → 兜底价 { miss:1, hit:0.02, output:4 }
```

- **first match wins**：无聚合、无叠加，唯一命中即结果；exclusion 用
  "更高优先级规则先命中"表达，不设 exclude 规则类型
- schedule 排除优先级：excludeDates / calendar-exclude → calendar-include →
  includeDates → 周规则（weekdays ∩ ranges）；日历/日期命中时忽略周规则
- `ResolvedPrice` 形保持 v1 不变（`inputMiss/inputHit/output/isPeak`），
  `isPeak` 语义改为"命中的规则是时段限定"（非恒真峰谷）
- v1 文件读取时**自动迁移**（按价格形状去重生成 peak/valley 方案与价格实体，
  同价模型共享同一组方案；v1 峰输入价未存 → 沿用谷输入价，可手动补真实峰值）

```jsonc
{ "version": 2,
  "calendars": { "holidays": { "name": "节假日", "dates": ["2026-10-01", "01-01"] } },
  "prices":   { "deepseek-peak":  { "name": "DeepSeek 峰价", "input": {"miss":2,"hit":0.04}, "output": 8 } },
  "plans":    { "deepseek-peak-workday": { "name": "工作日高峰",
                "rules": [ { "schedule": { "timezone": "Asia/Shanghai", "weekdays": [1,2,3,4,5],
                            "ranges": [["09:00","12:00"],["14:00","18:00"]] }, "price": "deepseek-peak" } ] } },
  "providers": { "deepseek": { "models": { "deepseek-flash": { "alias": "deepseek-v4-flash",
                "plans": [ { "plan": "deepseek-peak-workday", "enabled": true },
                           { "plan": "deepseek-valley-always", "enabled": true } ] } } } } }
```

## Module Design

四层切分（对齐 pi-prompt 三层范式 + 抽屉表现层）：

- **纯函数层（pricing-query / pricing-store / pricing-desc）**：
  `resolvePricing()` / `createPricingResolver()` / `resolveDebug()` /
  `readPricing()` / `writePricing()` / `seedPricing()` / `migrateV1ToV2()` ——
  不依赖 pi ExtensionAPI，node 单测直接断言。
  `resolvePricing()` 是跨扩展共享的核心 API：输入 (model, provider, timestamp)，
  输出 ResolvedPrice（含 isPeak 标记），v2 后签名与输出形状不变。
  `createPricingResolver()` 是批量变体：一次读取 schema，返回可复用闭包，
  供台账统计逐条调价避免反复磁盘 IO（pi-prompt 0.3.1 经 npm 子路径
  `@foolsecret/pi-pricer/pricing` 动态 import 消费）。
  `resolveDebug()` 输出解析链（每步方案名/是否命中/未中原因），
  `/price resolve` 与抽屉详情页共用，是 v2 first-match 语义的可视化窗口。
  `pricing-desc` 提供价目/星期/时段的共享中文文案（price / weekdaysCn / rangesCn）。

- **编辑会话层（pricing-draft）**：
  `PricingDraft` —— 内存草稿会话（深拷贝 schema + changedAreas 记账），
  `toggleBinding` / `addBinding` / `removeBinding` / `setAlias` /
  `setPriceField` / `upsertPrice` / `deletePrice` / `upsertPlan` /
  `duplicatePlan` / `deletePlan` / `setRulePrice` / `setRuleValidUntil` /
  `addRule` / `removeRule` / `upsertCalendar` / `deleteCalendar`；
  `save()` 先 `validate()` 再全量写盘，`reset()` 重读磁盘丢弃改动。
  纯逻辑、无 TUI 依赖，可完整单测。

- **行折叠层（pricing-builder）**：
  `listProviderRows()` / `listModelRows()` / `listProviderPlans()` —— 把 v2 五注册表
  折叠成抽屉行（ProviderRow / ModelRow），TUI 无关，node 单测直接断言行内容。

- **格式化层（pricing-format）+ 表现层（pricing-ui）**：
  文本渲染 `renderPriceList()` / `renderModelDetail()` / `renderSchema()` /
  `renderPlanList()` / `renderPlanDetail()` / `renderPriceRegistry()` /
  `renderCalendarList()` / `renderResolveResult()`（纯函数）；
  抽屉 `PricingDrawer`（消费 PricingDraft + builder 行构建可编辑 SettingsList +
  ActionMenu 动作页，filePath 注入可测，不访问 ExtensionAPI）。

- **接线层（pricing-commands）**：
  PricingCommands.mount(pi) 注册 `/price` 命令，无参 → drawer.open(ctx)（headless
  返回 false → 回退 /price list 文本）；子命令 list/model/plan/price/calendar/
  resolve/bind/unbind/move/schema 全部经注入 filePath 读写，首次启动 seedPricing。
  DI 可测。

## Do's and Don'ts

- Do 把价格数据全部放在 JSON 文件里，代码中不硬编码任何厂商特定价格
- Do 保持 `resolvePricing()` 的 fallback 链：JSON → 硬编码兜底
- Do 三级钻取的交互层级与 pi-prompt /prompt config 保持一致
- Do 所有抽屉编辑先写 `PricingDraft`，Ctrl+S 才落盘
- Do 删除类操作一律经引用保护（`validate()` 的 checkBindings / checkPlans）
- Do 用显式深度计数器（`depth`）判断当前层级，**不要用标题等展示层状态反推**
- Do 补全项的 `description` 必须非空（一致性测试会拦）
- Do 动态 id 项的 description 用其显示名（如方案名），便于用户确认再选中
- Do 新增子命令时同步 `pricing-cli-spec.ts`（单一数据源），补全/help/dispatch 自动跟进
- Do "首次提示、再次确认"的守卫（如 Esc 退出）必须带已提示状态位
- Do 每个 submenu 的关闭路径统一走一个 `finish()`，避免双重关闭
- Do 让 `/price list` 在 headless 模式下回退为文本输出，且每个编辑能力都有 CLI 等价命令
- Don't 用 SettingsList 做"执行动作"（普通项 Enter 是空操作）——用 `submenu` 或 ActionMenu
- Don't 在抽屉子菜单内期待顶层快捷键生效（子菜单会接管输入）
- Don't 在 SettingsList 里循环价格值（精确数值不适合离散循环）
- Don't 让 store/draft 层依赖 ExtensionAPI（纯函数可独立测试）
- Don't 在格式化层做 JSON 读写（只渲染，不 IO）
- Don't 自绘补全菜单：渲染归 pi-tui（`Editor` + `SelectList`），本项目只提供候选数据
- Don't 在补全回调里做重 IO 或抛错（异常必须降级为静态候选/null）
- Don't 给 `ExtensionInputComponent` 传空 `onCancel`（会导致 Esc 卡屏）
- Don't 丢弃 `showOverlay` 的返回值（拿不到 handle 就无法关闭）
- Don't 为每个厂商硬编码峰时段逻辑（数据驱动：calendars/plans/rules 定义一切）
