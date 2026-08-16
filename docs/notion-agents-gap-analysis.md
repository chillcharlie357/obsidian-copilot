# Notion Agents 特性调研与 Obsidian Copilot 差距分析

> 调研日期：2026-08-16。资料源：
> [Notion 3.0: Agents 发布说明](https://www.notion.com/releases/2025-09-18)、
> [Notion 3.3: Custom Agents 发布说明](https://www.notion.com/en-gb/releases/2026-02-24)、
> [Notion Agents 产品页](https://www.notion.com/product/agents)、
> [Notion Agent 帮助文档](https://www.notion.com/en-gb/help/notion-agent)。

## 一、Notion Agents 特性全景

### 个人 Notion Agent（所有用户，按需对话）

| 类别 | 特性 |
|---|---|
| 上下文 | 默认带入**当前所在页面**；划选 block 后聚焦所选 block；`@` 引用**页面与成员**；「All sources」多源选择；上传文件（PDF/CSV 解析） |
| 记忆与个性化 | **Instructions 页面**（写作风格、引用习惯、归档位置）+ **持续记忆**（长期记住偏好，不用重复交代）；Skills 定制 |
| 模型 | 内置模型选择器（Auto / Claude Sonnet 5 / GPT / Gemini / Grok），切换即时生效 |
| 动作能力 | 创建/编辑页面与数据库（视图、属性、关联）；**批量操作**（一次改几十上百页）；公式生成；读取评论与**版本历史**；数据分析与摘要 |
| 连接器 | Slack / Gmail（搜、起草、发送——写操作需确认）/ 日历（排期、会议准备、交互式日程格）/ Google Drive / GitHub / Jira；网页浏览 |
| 引用 | 回答带**引用溯源**，可跳回源页面 |
| 反馈 | 每条回复 👍/👎，👎 可附原因 |
| 安全 | 权限继承（只能看到你能看的）；**全部改动可回滚**（版本历史）；运行日志；提示词注入防护 |

### Custom Agents（Business/Enterprise，3.3 起）

| 类别 | 特性 |
|---|---|
| 自治 | **完全自主运行**：触发器 + 定时计划，24/7 无需人工提示 |
| 团队 | 团队共享；每个 Agent 独立**权限**（页级访问控制）、instructions、sources、模型 |
| 创建 | 自然语言描述即可生成；模板库 |
| 集成 | Slack（发消息、emoji 触发、@触发）、Mail、Calendar、MCP（Linear/Figma/HubSpot/Stripe/GitHub… + 自定义 MCP） |
| 治理 | 管理员：谁能创建、随时禁用、**审计日志**（触发什么/做了什么/为什么）、credit 消耗监控与阈值告警 |

## 二、对比矩阵（✓ 已有 / △ 部分 / ✗ 缺失 / — 不适用）

| 能力 | Obsidian Copilot 现状 | 差距评估 |
|---|---|---|
| 多轮对话 + 流式 + 工具过程可见 | ✓（侧边栏、推理折叠、工具卡片） | 无差距 |
| 多 agent 后端 | ✓（Agent Profile，含任意 ACP agent） | 优于 Notion（Notion 只能选模型，我们可选整个 agent） |
| 自定义指令 / 系统提示 | ✓（可编辑 + 预览/编辑卡片） | 无差距 |
| Slash 命令 | ✓（agent 命令 + vault 自定义命令） | 基本对齐 Notion Skills |
| @ 引用文件/文件夹 + 拖拽 + 划词右键 | ✓ | 对齐 |
| **当前笔记/当前页面自动上下文** | ✗（需手动 @） | **高**。Notion 默认带当前页 + 划选 block 聚焦；Obsidian 用户 90% 的诉求就是「基于这篇笔记」 |
| **建议动作**（基于当前页生成行动项/精简等） | ✗ | **高**。Notion 打开聊天即提示可执行动作 |
| **持续记忆**（跨会话记住偏好） | ✗（仅 per-session 前缀） | **高**。Notion 记忆页；Obsidian 场景天然适合「memory 文件」 |
| **引用溯源**（结构化 citations） | △（依赖 `[[链接]]`，无编号引用/来源条） | 中。wikilink 已可点击，缺显式 citation 样式与「来源清单」 |
| **文件上传 / 非 md 附件**（PDF/CSV/图片） | ✗（仅 md 文件/文件夹） | 中。txt/csv 便宜可做；图片粘贴依赖 ACP image + DSH 图像能力 |
| 反馈（👍/👎） | ✗ | 中。DSH 本身有 feedback 事件，可桥接 |
| **批量操作**（一次改大量笔记） | ✓（agent 有文件工具，可跨文件） | 无差距 |
| **版本回滚** | △（Obsidian 核心版本历史天然可用，未在 UI 串联） | 低-中。文件变更 chip 可加「查看历史」入口 |
| 模型选择 | △（换 profile = 换 agent；DSH 模型切换未暴露） | 低-中 |
| **工作区/页级权限**（限定 agent 可见范围） | △（DSH permission preset 全局；工作区=vault 根） | 中。「以文件夹 X 为工作区」可做（session cwd 子目录） |
| 定时/触发器自治运行 | ✗ | 低-中。Obsidian 本地应用，仅「Obsidian 运行时」计划任务可行 |
| 团队共享/多用户/审计/credit | —（本地单用户） | 不适用 |
| Slack/Mail/Calendar 连接器 | —（本地工具，超出产品边界） | 不适用 |
| 提示词注入防护 | ✗（未显式声明） | 低-中。system prompt 补规则即可 |
| 交互式富组件（会议日程格、表单） | ✗ | 低。聊天渲染已支持 markdown/表格/callout |

## 三、建议优先级（结合 ACP 架构落地成本）

- **P0（高价值、低成本）— 已全部完成 ✅（2026-08-16）**
  1. **当前笔记上下文**：composer 顶部「当前上下文」pill（跟随活动编辑器）；选择器加「当前笔记」「最近笔记」条目；快捷动作 `/总结当前笔记`、`/生成行动项`、`/精简所选`（划词右键已有类似入口，做成命令即可复用）。
  2. **持续记忆**：vault 里 `.obsidian-copilot/memory.md` 随会话前缀一起注入（用户可编辑、agent 可经 `/remember` 命令追加）；instructions 页与记忆分离。
  3. **反馈**：助手消息加 👍/👎，👎 收集原因写回 memory（或发一条后续消息）；可经 ACP `_meta` 扩展桥接 DSH feedback 事件。
- **P1（中价值）**
  4. **引用溯源 UI**：助手回复中的 `[[链接]]` 渲染为可点击引用 chip + 消息底部「引用来源」行（解析 wikilinks）。
  5. **非 md 附件**：选择器/拖拽支持 txt/csv/json 等文本类附件（内嵌为 resource）；图片粘贴作为后续项（需 adapter 开启 ACP image + DSH 图像通道验证）。
  6. **工作区=子文件夹**：新建会话可选「限定工作区」文件夹（session cwd=子目录，agent 权限边界随之收紧）。
- **P2（低价值/需评估）**
  7. 定时任务（Obsidian 运行期间的计划 prompt + 结果写入笔记）。
  8. 模型切换下拉（扩展 ACP 自定义方法）。
  9. 文件变更 chip → 版本历史入口。
  10. 提示词注入防护规则进默认 system prompt。
