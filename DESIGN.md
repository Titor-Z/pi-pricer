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
---

# pi-pricer Model Pricing Config

Pi 生态的模型计费数据共享中心。解决"厂商调价频繁，硬编码价表跟不上"的问题：
将价格数据从代码中抽离为 `~/.pi/model-pricing.json`，由 pi-pricer 拥有数据主权 + 
提供编辑 UI，pi-prompt / pi-usage / 未来组件统一消费同一份 JSON。

## Overview

产品人格是**数据优先**：一切价格数据来自 JSON 文件，UI 只是浏览层。用户修改价格
时直接编辑 JSON 或用 `/price set` 命令，不通过抽屉的离散循环（价格是精确数值，
不适合 SettingsList 的循环换档模式）。

交互层级：`/price` → Provider 列表 → Model 列表 → Model 详情。
命令面：`/price set` 精确修改 + `/price reload` 热更新。

情绪响应：透明、可预期。用户看到的每一行价格都直接映射到 JSON 文件的某个字段，
修改后立刻反映。

## Colors

继承 pi Theme（与 pi-prompt 抽屉一致）：
- **Accent**：标题 + 当前选中值
- **Border Accent**：上下 DynamicBorder 边框

## Components

### Shell（三级钻取容器）
- 双 DynamicBorder accent 边框（上进下出）
- 标题文本随层级变化："模型计费配置" → "deepseek" → "deepseek-flash"
- Esc 回退层级 / 关闭

### Provider List（Level 0）
- SettingsList 展示所有厂商
- 每行：`<provider-id>  (<N>模型 · <峰时段描述>)`
- 说明栏：该厂商的计费参数与峰时段规则概述
- Enter → 下钻 Model List
- 实现：每行 SettingItem 带 `submenu`，Enter 用 SettingsList 原生 submenu 机制
  打开第 1 级；标题 Text.setText 随层级更新（"模型计费配置 · <provider>"）

### Model List（Level 1）
- SettingsList 展示当前厂商下的所有模型
- 每行：`<model-id>  out ¥4.00→¥8.00 · miss ¥1.00 hit ¥0.02`
- 说明栏：该模型的输入价概述
- Enter → 下钻 Model Detail
- Esc → 返回 Provider List（子级 SettingsList 的 onCancel 调外层 done，恢复父级选中 +
  标题还原）

### Model Detail（Level 2）
- 纯文本渲染（非 SettingsList，因为不需要循环交互）
- 显示：别名 / 输入 miss+hit / 输出 std+peak / 峰时段 / 编辑命令提示
- handleInput 只拦截 Esc → 返回 Model List（恢复第 1 级标题）

## Interaction

### /price 命令面

| 命令 | 交互 | 用途 |
|---|---|---|
| `/price` | 无参 → 三级抽屉（TUI）/ list 文本（headless） | 默认浏览 |
| `/price list` | 文本表格输出 | 快速查看 |
| `/price show <provider> <model>` | 文本详情输出 | 查看单模型 |
| `/price set <provider> <model> <field> <value>` | 命令行直接修改 JSON | 精确编辑 |
| `/price schema` | 文本输出 schema 说明 | 手动编辑参考 |
| `/price reload` | 重新读取 JSON 文件 | JSON 编辑后热更新 |

### 键盘映射（与 pi-prompt /prompt config 一致）

- ↑/↓: 移动光标
- Enter: 下钻到子级（Provider → Model → Detail）
- Esc: 返回上级 / 关闭
- Space: 无效（详情页无循环值）
- 键入: 搜索过滤

### 无 TUI 回退

headless 模式下 `/price` 回退为 `list` 文本输出（与 pi-prompt 的 config 抽屉
无 TUI 回退一致）。

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

## Module Design

四层切分（对齐 pi-prompt 三层范式 + 抽屉表现层）：

- **纯函数层（pricing-query / pricing-store）**：
  `resolvePricing()` / `readPricing()` / `writePricing()` / `seedPricing()` —— 
  不依赖 pi ExtensionAPI，node 单测直接断言。
  `resolvePricing()` 是跨扩展共享的核心 API：输入 (model, provider, timestamp)，
  输出 ResolvedPrice（含 isPeak 标记）。

- **行折叠层（pricing-builder）**：
  `listProviderRows()` / `listModelRows()` —— 把 JSON 折叠成抽屉行
  （ProviderRow / ModelRow），TUI 无关，node 单测直接断言行内容。

- **格式化层（pricing-format / pricing-ui）**：
  文本渲染 `renderPriceList()` / `renderModelDetail()` / `renderSchema()`（纯函数）；
  抽屉 `PricingDrawer`（表现层，消费 builder 行构建 SettingsList + submenu 下钻，
  filePath 注入可测，不访问 ExtensionAPI）。

- **接线层（pricing-commands）**：
  PricingCommands.mount(pi) 注册 `/price` 命令，无参 → drawer.open(ctx)（headless
  返回 false → 回退 /price list 文本）；首次启动 seeding。DI 可测。

## Do's and Don'ts

- Do 把价格数据全部放在 JSON 文件里，代码中不硬编码任何厂商特定价格
- Do 保持 `resolvePricing()` 的 fallback 链：JSON → 硬编码兜底
- Do 三级钻取的交互层级与 pi-prompt /prompt config 保持一致
- Do 让 `/price list` 在 headless 模式下回退为文本输出
- Don't 在 SettingsList 里循环价格值（精确数值不适合离散循环）
- Don't 让 store 层依赖 ExtensionAPI（纯函数可独立测试）
- Don't 在格式化层做 JSON 读写（只渲染，不 IO）
- Don't 为每个厂商硬编码峰时段逻辑（数据驱动：JSON 里的 peakHours 定义一切）
