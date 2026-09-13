---
version: alpha
name: pi-pricer Model Pricing Config
description: 模型计费配置中心的数据契约、解析语义与可复用模块切分。定义 Schema v5（document 模型 + 事务化 DAO）、规则匹配语义、/price 命令面与跨扩展共享的解析 API。
colors:
  accent: accent
  border-accent: borderAccent
omitted:
  - section: typography
    reason: "终端 TUI：字体随用户终端主题"
  - section: spacing
    reason: "行距/缩进由终端列表布局决定"
  - section: rounded
    reason: "终端无圆角"
  - section: elevation
    reason: "TUI 用边框分隔层级"
components:
  tui:
    # TUI 编辑面已重建：抽屉 + 自绘菜单/输入子页/编辑器
    status: implemented
    renderer: pi-tui Component + pi-coding-agent DynamicBorder / Theme
---

# pi-pricer Model Pricing Config

Pi 生态的模型计费数据共享中心。职责边界：**只负责规则的制定与存储**，
`/price` 管理价格、日历、规则、方案、模型绑定；**不负责展示"当前什么价"**——
那是消费方（pi-usager `/usage status`、pi-prompt 对账）的事，pi-pricer 通过
`resolvePricing()` 把结构化结果透传出去。

## Overview

数据优先、可编程：五个集合（collection）以 document 形式存放在同一份
`~/.pi/model-pricing.json` 中，彼此以不透明 `_id` 引用（数据库思维，跨表 join）。
写入走事务：校验 + 乐观锁 + 原子提交，失败整笔回滚。

命令面收敛为 6 个：`/price`（无参）、`rate`、`calendar`、`rule`、`plan`、`ai`。

## Data Schema（JSON v5）

> v1–v4 结构与本版**不兼容**：读到 `version ≠ 5` 的文件时，内存回退为 v5 内置种子，
> **不主动改写磁盘**，直到用户实际保存。

### 文档公共字段

所有实体都是 document：

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` | string | 16 位十六进制（4B 秒级时间戳 + 2B 随机 + 2B 自增），不可读，仅作引用 |
| `createdAt` | string | 毫秒级 ISO 8601；**规则优先级依据**（后创建覆盖先创建） |
| `updatedAt` | string? | 毫秒级 ISO 8601；更新时写入 |

可读性由各表 `name` 承担（集合内唯一）；`_id` 只用于跨表引用。

### 五集合

```jsonc
{
  "version": 5,
  "rates": [
    { "_id": "084160217307451e", "createdAt": "...",
      "name": "DeepSeek 谷价", "inputMiss": 1, "inputHit": 0.02, "output": 4 }
  ],
  "calendars": [
    { "_id": "366c21606bf01df0", "createdAt": "...",
      "name": "中国法定节假日", "region": "CN", "dates": ["01-01", "10-01"] }
  ],
  "rules": [
    { "_id": "...", "createdAt": "...", "name": "DeepSeek 工作日高峰",
      "rateId": "...", "timezone": "Asia/Shanghai",
      "weekdays": [1,2,3,4,5], "ranges": [["09:00","12:00"],["14:00","18:00"]],
      "includeCalendars": [], "excludeCalendars": [],
      "includeDates": [], "excludeDates": [],
      "validUntil": "2026-12-31" }
  ],
  "plans": [
    { "_id": "...", "createdAt": "...", "name": "deepseek-flash 方案",
      "alias": "Flash 默认", "enabled": true, "ruleIds": ["...", "..."] }
  ],
  "models": [
    { "_id": "...", "createdAt": "...",
      "provider": "deepseek", "model": "deepseek-flash", "planId": "..." }
  ]
}
```

### 字段与引用关系

| 集合 | 关键字段 | 引用 |
|---|---|---|
| `rates` | `name`（唯一）、`inputMiss`、`inputHit`、`output` | — |
| `calendars` | `name`（唯一）、`region?`、`dates`（`YYYY-MM-DD` 或 `MM-DD`） | — |
| `rules` | `name`（唯一）、`rateId`、`timezone`、`weekdays`、`ranges`、`includeCalendars`、`excludeCalendars`、`includeDates`、`excludeDates`、`validUntil?` | `rateId → rates._id`；`*Calendars → calendars._id` |
| `plans` | `name`（唯一）、`alias?`、`enabled`、`ruleIds` | `ruleIds → rules._id`（集合，可空） |
| `models` | `provider`、`model`、`planId` | `planId → plans._id`；`(provider, model)` 唯一 |

- **模型 → 方案为单值绑定**：一个模型任一时刻只对接一个方案；方案可启用/禁用。
- **方案 ↔ 规则**：`plan.ruleIds` 表示"包含哪些规则"，**不是优先级**（优先级由 `createdAt` 决定）。
- **方案允许为空**（`ruleIds: []`）：先建方案、再逐步纳入规则；空方案解析时走兜底价。

### 校验与引用保护（提交前统一运行）

- `_id` 合法（16 位 hex）且集合内唯一
- `name` 集合内唯一（`models` 无 `name`，用 `(provider, model)` 唯一）
- `rules.rateId` / `includeCalendars` / `excludeCalendars` 必须存在
- `plans.ruleIds` 每一项必须存在
- `models.planId` 必须存在
- 日期 / 时段 / 星期 / 时区格式合法

删除保护（被引用即拒绝，并指出引用者）：

| 删什么 | 被谁挡住 |
|---|---|
| rate | 任一 `rule.rateId` |
| calendar | 任一 `rule.includeCalendars / excludeCalendars` |
| rule | 任一 `plan.ruleIds` |
| plan | 任一 `model.planId` |

## Resolution 契约

```
resolvePricing(model, provider?, timestamp?, filePath?)
  1. models 查 (provider, model) → planId；无模型 → 兜底价
  2. plans 查 planId；缺失或 enabled=false → 兜底价
  3. plan.ruleIds → rules，按 createdAt 升序评估
  4. 单条规则匹配 = 各条件的「交集」（全部成立才命中）：
       validUntil 过期 → 否
       命中 excludeDates / excludeCalendars → 否（排除优先）
       includeCalendars 非空且全不命中 → 否
       includeDates 非空且不命中 → 否
       weekdays 非空且不含当日 → 否
       ranges 非空且不在时段 → 否
  5. 后创建的规则覆盖先创建的（交集处覆盖；无交集各自生效）
  6. 全程无命中 → 兜底价
```

- **组合规避减法**：不为"排除某方案"设计规则类型；峰谷用"兜底规则先建 + 特例规则后建"的组合表达。
- `ResolvedPrice`（对外稳定契约）：`inputMiss` / `inputHit` / `output` / `isPeak` +
  来源元数据 `planId?` / `planName?` / `planAlias?` / `rateId?` / `ruleId?`（兜底时均 `undefined`）。
- `isPeak` = 命中规则是否带时段/星期约束（供消费方区分特殊时段，不参与计价）。
- `resolveDebug` 返回完整命中/未命中链（按评估顺序）。
- `createPricingResolver(filePath?)`：一次读盘，返回可复用闭包（批量调价零磁盘 IO）。

## 事务模型（DAO）

模拟 Mongo 的最小 DAO（`src/db/`）：

| 组件 | 职责 |
|---|---|
| `id.ts` | 16 位 hex id 生成 / 校验 / 时间戳反解 |
| `document.ts` | `Document` 基类型、`newDocument` / `touchDocument` / `compareDocumentOrder` |
| `collection.ts` | 单集合 CRUD + 唯一性 + 深拷贝（`_id` 索引） |
| `errors.ts` | `UniqueNameError` / `DanglingRefError` / `ValidationError` / `ConcurrencyError` |
| `validate.ts` | 全量校验 + 四类删除保护 |
| `database.ts` | 五集合组装 + `Transaction`（提交语义） |

事务语义（对齐 SQL）：

```
db.transaction(fn):
  工作副本 → 全量校验 → 乐观锁 → 一次原子写（临时文件 + rename）→ 并入内存
  任一环节失败 → 丢弃工作副本（回滚），磁盘不变
db.begin(): 返回可长期持有的事务（AI 草稿），由调用方 commit / rollback
```

- 乐观锁：提交前比对文件内容哈希，与加载时不一致（被外部修改）→ 抛 `ConcurrencyError`。
- 读取：`db.rates` 等直接只读；**写一律走 `db.transaction()` / `db.begin()`**。

## 命令面（6 个）

| 命令 | 作用 |
|---|---|
| `/price` | 列出已设定方案的模型（字母序 + 厂商标注 + 方案别名 + 启停标注） |
| `/price rate` | 价格表 CRUD（`list / add / set / remove`） |
| `/price calendar` | 日历表 CRUD（`list / add / add-dates / remove`） |
| `/price rule` | 规则 CRUD（`list / add / remove`，`add` 支持 `--weekdays/--ranges/--include-cal/--exclude-cal/--include-dates/--exclude-dates/--valid-until/--timezone`） |
| `/price plan` | 方案 CRUD（`list / add / set-alias / add-rule / remove-rule / enable / disable / bind / remove`） |
| `/price ai` | 会话级启用 AI 编辑模式（`on / off`） |

- 名称含空格用双引号包裹：`/price rate add "促销价" 0.5 0.01 2`。
- 单一数据源 `pricing-cli-spec.ts`：dispatch / 补全 / help 三处从它派生。
- 补全三层：子命令 → 动作 → 动态 name（含空格自动加引号），异常时降级为空。

## TUI 编辑面

入口：`/price` 或 `/price rate|calendar|rule|plan` 在 TUI 下打开抽屉（参数决定直达页）；
带二级动作（如 `/price rate add …`）不开抽屉，走文本执行；headless 全部回退文本。

### 页面树

```
根页：模型列表（字母序，行内 `模型@厂商  → [方案名@别名]  [状态]`）；面包屑 `模型`
  ├ Enter 模型 → 模型详情（只与方案打交道）
  │    ├ 方案：<name>（Enter 从方案表选，改绑）
  │    ├ 禁用 / 启用该方案（plan.enabled）
  │    └ 删除该方案（若有其它模型在用则拒绝）
  └ ＋添加新的模型计费
       └ 检索模型（关键字输入子页）→ 分页候选列表（8 条/页，PgUp/PgDn）
            └ 选已有方案 / 新建方案并绑定

统一导航规则：**需要进一步选择 / 输入 / 确认的行一律进子页**（`选择价格` / `编辑时区` /
`编辑星期` / `编辑时段` / `切换包含日历` / `重命名` / `确认删除` …）；只有当场可判定的
单一开关（方案启用/禁用）就地生效。绝不再出现「有的进子页、有的弹窗」——面包屑永远回答
“我在第几层”

四张管理表不在根页入口，由参数直达：
  /price rate / calendar / rule / plan → 对应管理页
       ├ 价格表 → 列表 + 新建 → 价格详情（三个数值 / 改名 / 删除）
       ├ 日历表 → 列表 + 新建 → 日历详情（改名 / 日期增删 / 删除）
       ├ 规则表 → 卡片式列表（4 条/页）+ 新建 → 规则详情（价格/时区/星期/时段/含排日历/指定排除日期/有效期/改名/删除）
       └ 方案表 → 列表 + 新建 → 方案详情（别名/启停/规则增删/引用此方案的模型+添加模型/改名/删除）
```

底部状态栏统一一行，**放在抽屉框内**（内容与底边框之间，上方空一行）：
`<状态> · <页面键位提示> · Ctrl+S 保存 · Ctrl+R 重置`。

**帧统一规则（强制）**：

- 抽屉统一渲染整帧：`顶边框 → 面包屑 → 空行 → 页面内容 → 空行 → 状态栏 → 底边框`。
- **输入页帧（强制）**：所有编辑（含文本输入）都是压栈的**子页**，没有弹窗：
  `顶边框 → 面包屑（末级 = 编辑 X）→ 空行 → 输入行 → 错误/注 → 空行 → 状态栏 → 底边框`。
  输入页不自绘边框/键位；Esc 只返回上一层（不额外提交，改动静默丢弃由 `Ctrl+R` 负责）。
- 页面**只暴露数据**（`title()` / `footerHints?()`），`render()` 只返回内容行；
  绝不自行画边框、标题或快捷键——各画一套必然跑偏。
- 未保存状态优先：`● 未保存改动` / `✓ 已保存`，后接最近一次操作反馈。
- `Ctrl+S` / `Ctrl+R` 是抽屉全局键，所有页面底栏都带上（无弹窗，故无例外）。
- `ActionMenu` 默认键位 = `↑↓ 移动 · Enter 执行 · Esc 返回`，全局一致，页面不再各写一套。

### 面包屑导航

用户需要知道“我在哪一层”，因此标题行改为面包屑（页面栈的标题链）：

- 数据源 = `this.pages` 的 `title()`；末级 `accent` + 加粗，祖先 `dim`，分隔符 ` › ` `dim`。
- 分页统计（`第 x/y 页`）由 `ActionMenu` 画在**列表下方**（`dim`），不占面包屑位置。
- 命名：根 = `模型`；四张表 = `价格 / 日历 / 规则 / 方案`；详情 = 实体名（模型 `名@厂商`）；
  动作页 = **动词 + 对象**（`选择方案` / `选择价格` / `编辑星期` / `编辑时段` / `切换包含日历` /
  `编辑指定日期` / `确认删除` / `重命名` / `新建价格` / `添加日期` / `检索模型` …）。
- 直达页（`/price rate`）栈是 `[模型列表, 价格表]`，面包屑自然是 `模型 › 价格`。
- **超宽折叠**：宽度不足时从最左（最老）的祖先开始丢段，保留能放下的**末 N 段**（N 不设上限），
  前缀 `… › `；**当前位置（末级）永不隐藏**，仍放不下则截断末级文字（不折行）；
  宽度一律按 `visibleWidth`（中文 2 列）计算。
- 输入页与列表页同级：标题进面包屑（如 `模型 › 规则 › 工作日高峰 › 编辑时区`），
  输入类页的键位提示 = `Enter 提交 · Esc 返回`。

### 列表布局与着色

两种布局（`ActionMenu` 构造参数 `cards` 切换）：

- **行式（默认）**：`MenuEntry.cells` 声明列，`align: true` 的列按同页最大宽度右侧补空，一行一条。
- **卡片式（`cards = true`）**：条目两行 —— `标题` 一行、`  → <detail>` 一行（`dim`），条目之间空一行。
  规则表（`/price rule`）用这种：`规则名` + `→ 价格 · 星期 · 时段`。

行内容 = 「单元格 cell」+「行内片段 span」；
- **上下移动光标时列不跳动**：选中行也先按列补空，再整行上色。
- 语义色映射（不造新色名，只用 pi 主题已有语义色）：

| 用途 | 语义色 | dark 主题色值 |
|---|---|---|
| 列表默认文字（与底栏同档） | `muted` | gray #808080 |
| `@厂商`、`@方案别名` | `dim` | dimGray #666666 |
| 选中行 | `accent` + `selectedBg` 背景（+ 加粗） | 主题强调色 |
| 状态「启用」/「已禁用」/「方案缺失」 | `success` / `warning` / `error` | 绿 / 黄 / 红 |

- 选中行必须先拼**纯文本**再套色（不能套已着色的 span），否则 span 内部的 SGR reset 会提前终止 `selectedBg` 背景。
- 帧内固定空行：面包屑下方、`＋` 动作条上方（分区）。

### 列表分页

从 pi 模型注册表检索出的候选模型可能很多，必须分页，否则会撑开抽屉、光标“上下无反应”：

- `ActionMenu` 构造参数 `pageSize`（检索页 **8 条/页**、规则表卡片式 **4 条/页**，0 = 不分页）。
- 只渲染当前光标所在页的窗口；`↑↓` 跨页时自动跟随，`PgUp/PgDn` 整页跳跃。
- 末尾连续以 `＋` 开头的条目是**固定动作条**：不参与分页、不计数，常驻在分页统计**下方**
  （`条目 → 第 x/y 页 → ＋新建规则`），光标可下移到它，此时仍展示最后一页。
- 页码画在**列表下方**（`第 x/y 页`）；`footerHints()` 自动追加 `PgUp/PgDn 翻页`（无分页时不显示）。

### 草稿会话（PricingSession）

- 持有 `Database` + 一个**长期事务**（`db.begin()`）；页面直接改工作副本，渲染读工作副本
- `Ctrl+S` → `withFileMutationQueue` + 全量校验 + 乐观锁 + 原子写；成功后重建工作副本
- `Ctrl+R` → 丢弃工作副本并重读磁盘
- `isDirty` = 工作副本与已提交态的 JSON 比较
- 根页脏改动 Esc 两段式（首次提示、再次退出）

### 组件

| 组件 | 说明 |
|---|---|
| `ActionMenu` | 自绘菜单（SettingsList 普通项 Enter 不触发，不能用）；条目支持函数形式，增删后自动反映；行由 `cells`/`spans` 描述，支持列对齐与语义着色；`pageSize>0` 时分页 |
| `InputPage` | 输入子页：Enter 就地校验（失败不离页、不丢输入）、「注：」脚注、Esc 返回 |
| `WeekdaysEditor` | 星期多选（◉/◌，Enter 即时生效，Esc 只返回） |
| `ItemListEditor` | 字符串列表增删（时段/日期/日历日期共用，见 `buildStringListPage`），Enter 即时生效，Esc 只返回 |

### 键位

`↑↓` 选择 · `Enter` 进入/执行 · `Esc` 返回（根页两段式）· `Ctrl+S` 保存 · `Ctrl+R` 重置
自定义键一律用 pi-tui `matchesKey` 归一化，避开增强键盘协议下的裸字节陷阱。

### 开关语义

- **方案级 `plan.enabled`**：关掉后，凡绑定该方案的模型都走兜底价。
- 模型本身不再有独立开关（早期曾设 `model.enabled`，已删除）：模型只对接方案。
- 模型页与方案页都可切换方案的启停（同一状态）。

## AI 辅助配置

- 12 个语义动作（`pricing-agent-actions.ts`）：`upsertRate / deleteRate /
  upsertCalendar / addCalendarDates / deleteCalendar / upsertRule / deleteRule /
  upsertPlan / setPlanEnabled / deletePlan / bindModel / unbindModel`。
  引用一律用 `name`，agent 无需处理 `_id`。
- 5 个工具（`pricing-agent-tool.ts`）：`price_get / price_apply / price_review /
  price_save / price_discard`。
- **能力隔离**：工具始终 `registerTool`（声明存在）但默认**不激活**；
  `/price ai` 确认后 `setActiveTools` 加入激活集，模型才看得到。
- **整批原子**：一次 `price_apply` 的多个动作在一个长期事务上执行，
  任一失败则整批回滚（含此前草稿），返回每条原因。
- 落盘经 `withFileMutationQueue`（与 pi 内置 edit/write 共享同一文件队列）。
- `skills/price-config/SKILL.md` 教 agent 工作流与格式，写死禁止直接改 JSON、禁止猜测。

## Module Design

```
extensions/index.ts          薄入口：注册 5 工具 + 挂载 /price
src/
  pricing-types.ts           v5 五集合类型 + ResolvedPrice/ResolutionDebug + FALLBACK_PRICE
  pricing-defaults.ts        v5 内置种子（16 位 hex id，引用闭合，兜底先于特例创建）
  pricing-store.ts           薄 IO：read / write(原子) / seed；非 v5 → 种子
  pricing-query.ts           resolvePricing / createPricingResolver / resolveDebug
  pricing-cli-spec.ts        命令面单一数据源 + AI 工具名
  pricing-commands.ts        /price 实现（渲染 + 分发 + 补全）
  pricing-agent-actions.ts   12 动作 typebox schema + PRICING_ACTION_KINDS
  pricing-agent.ts           applyAction 分发 + diffSchemas + PricingAgentService（草稿事务）
  pricing-agent-tool.ts      5 工具注册与执行守卫
  tui/
    pricing-session.ts       草稿会话（Database + 长期事务，save/reset/脏标记）
    pricing-prompt.ts        输入子页 InputPage（就地校验 + 「注：」脚注）
    pricing-editors.ts       星期 / 条目列表编辑器
    pricing-menu.ts          ActionMenu（菜单/列表，含分页）
    pricing-drawer.ts        抽屉主组件（页面栈 + 各管理页）
  db/                        id / document / errors / collection / validate / database
```

跨扩展共享 API（`package.json` exports）：
`@foolsecret/pi-pricer/pricing`（查询）、`/store`、`/types`、`/db`。

## Do's and Don'ts

- **Do** 用 `name` 定位实体，用 `_id` 做引用（人和 CLI 记不住 id）。
- **Do** 把每一笔写入放进事务；让校验与引用保护在提交前统一跑。
- **Do** 先建兜底规则（全时），后建特例规则（峰时段/节假日），让特例覆盖兜底。
- **Don't** 让 agent 用 `edit` / `write` / `bash` 直接改 `model-pricing.json`（绕过校验与乐观锁）。
- **Don't** 在 pi-pricer 里展示"当前价格"；那是消费方的事，我们只透传解析结果。
- **Don't** 依赖数组顺序表达规则优先级；优先级由 `createdAt` 决定。
- **Don't** 内联快照价格到规则/方案里；一律用 `_id` 引用，改一处全生效。