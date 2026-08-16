# Obsidian Copilot（Obsidian 插件）

> 通过 **ACP（Agent Client Protocol）** 连接 agent 的 Obsidian 侧边栏 Copilot 插件。
> 首个后端适配器将 ACP 语义映射到 **DeepSeek Harness（DSH）** 的 Web API；
> 由于插件与 agent 之间是通用 ACP 语义，未来可直接接入任何支持 ACP 的 agent
> （如 Zed 生态的 ACP agent），只需在设置中更换启动命令。
>
> 仓库：[github.com/chillcharlie357/obsidian-copilot](https://github.com/chillcharlie357/obsidian-copilot)

## 能力

- **侧边栏对话**：Obsidian 右侧栏 ItemView，多轮会话，流式输出（正文 + 推理过程 + 工具调用卡片）。
- **@ 引用文件/文件夹**：输入 `@` 在**侧边栏内部**弹出行内选择器（Codex 风格，非全局搜索框）。选中后以彩色标签（chip）形式显示在输入框与消息中，并以 ACP `embedded resource` 内嵌进上下文；选中文件夹（📁）会附目录清单并批量内嵌其中笔记（篇数上限可在设置调整），超出上限部分由 agent 自行读取。
- **Slash 命令**：
  - **agent 命令**：DSH 内置命令（`/plan` `/goal` `/compact` `/feedback`）通过 ACP `available_commands_update` 广告，原样随 prompt 发送；
  - **自定义命令**：vault 根目录 `.obsidian-copilot/commands/*.md`，文件名即命令名（如 `/review`），frontmatter `description` 为说明，正文为 prompt 模板，`$ARGUMENTS` 替换用户输入（客户端展开后发送）。
- **划词与拖拽入对话**：编辑器里划选文本 → 右键「添加到 Copilot」（插入引用块 + 源文件 chip + 行号）；文件树里把文件/文件夹直接拖进侧边栏即添加引用 chip。
- **直接修改 vault**：会话工作目录即 vault 根目录，DSH agent 通过自身工具直接读写笔记；vault 变更会以「✏️ 修改了 xx.md」提示出现在对话中（点击跳转）。
- **工具与审批**：工具调用以卡片展示（参数/结果），DSH 侧需要审批的操作会弹出权限确认框（`session/request_permission`），agent 提问暂以可见提示 + 自动取消处理。
- **当前笔记上下文**：输入框上方「当前笔记」pill 一键加入上下文；@ 选择器置顶「当前笔记/最近笔记」；内置快捷命令 `/总结当前笔记` `/生成行动项` `/总结所选` `/精简所选`。
- **持续记忆（自动）与反馈**：`.obsidian-copilot/memory.md` 随每个新会话自动注入，agent 在对话中学到用户偏好后会**自动用文件工具更新该文件**（无需任何命令，更新过程以工具卡片可见）；`/remember` 可手动补充；助手消息 👍/👎，👎 附原因写回记忆。
- **会话持久化**：会话映射保存在插件 data.json；重开 Obsidian 后自动 `session/load` 重放历史，DSH 端会话由其自身持久化。
- **服务自管理**：DSH 未运行时可自动在后台启动 `dsh web`（工作目录 = 当前 vault），插件退出时按设置关闭。

## 架构

```
Obsidian（插件）
   ├─ UI：侧边栏聊天 / @引用 / 工具卡片 / 审批弹窗
   ├─ ACP 客户端（JSON-RPC 2.0 over stdio，换行分隔）
   │     └─ 处理 agent→client：fs/read_text_file、fs/write_text_file（走 vault API）、
   │        session/request_permission
   └─ spawn: node adapter.cjs --dsn http://127.0.0.1:3080 ...

dsh-acp-adapter（独立 Node 进程，随插件分发）
   ├─ ACP 服务端：initialize / session/new / session/load / session/prompt /
   │   session/cancel / session/update 通知 / session/request_permission 请求
   └─ DSH 客户端：HTTP unary RPC（/api/session.*）+ WebSocket 事件流
        （/api/events.mux、/api/events.host），并按需 spawn `dsh web`

DeepSeek Harness（dsh web）
   └─ 真正的 agent：模型调用、工具执行（工作区 = vault 根目录）
```

ACP 语义映射（适配器内）：

| ACP | DSH |
|---|---|
| `session/new {cwd}` | `POST /api/session.create {cwd}` |
| `session/prompt {prompt}` | `POST /api/session.prompt {mode:"queue", content}`（resource 块包成 `<embedded-resource>` 文本） |
| `session/update: agent_message_chunk` | mux `assistant/chunk`（text-delta）流 |
| `session/update: agent_thought_chunk` | mux `assistant/chunk`（reasoning-delta）流 |
| `session/update: tool_call / tool_call_update` | mux `tool/call` / `tool/result` |
| `session/load` | `POST /api/session.history` 翻页 → 重放为 `session/update` |
| `session/cancel` | `POST /api/session.cancel` → 对应 prompt 以 `stopReason:"cancelled"` 应答 |
| `session/request_permission` | mux `approval/requested` ↔ `POST /api/respond` |
| prompt 完成判定 | `turn/end` + `events.host` 的 `session-status: running=false` |

## 环境要求

- Obsidian ≥ 1.5.0（桌面端，插件需要启动 Node 子进程）
- Node.js ≥ 20（DSH 本身要求）
- 已安装并配置好凭据的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh` 在 PATH 中，`~/.dsh` 已初始化）

## 安装（开发/本地）

```bash
pnpm install
pnpm build            # 构建 adapter（dist/dsh-acp-adapter.cjs）并复制进 plugin/dist/adapter.cjs

# plugin/dist/ 是完整可安装的插件目录（main.js、adapter.cjs、manifest.json、styles.css、versions.json）
# 将整个 plugin/dist/ 复制到你的 vault：<vault>/.obsidian/plugins/obsidian-copilot/
# 然后重启 Obsidian 并在「第三方插件」中启用 Obsidian Copilot。
```

插件设置：

- **Agent Profile**：可选的 agent 后端列表，DSH 只是内置预设之一。每个 profile 是一条启动命令（支持 `{adapter}`、`{vault}` 占位符），可新增/编辑/复制/删除——任何支持 ACP stdio 的 agent（如 `codex acp`、`zed --acp`）都能接入；切换后自动重连
- **@引用内容上限**、**文件夹引用篇数上限**、**显示推理过程**
- **会话系统提示词**：每个新会话首条消息前注入（聊天界面不可见），内置针对 Obsidian 场景优化的默认值（wiki 链接保留、frontmatter 约定、先搜索后新建、不碰 .obsidian 等），可自定义或清空关闭

## 开发

```bash
pnpm build:adapter        # 只构建适配器
pnpm build:plugin         # 只构建插件（含复制 adapter.cjs）
pnpm -r typecheck         # 全量类型检查
node scripts/test-acp-peer.mjs         # acp-core Peer 客户端协议测试（无需模型调用）
node scripts/e2e-adapter.mjs           # 适配器 E2E（需 dsh web 运行中；会发起真实模型调用）
node scripts/e2e-adapter.mjs --auto-start   # 并测试自动启动（用 --dsn 指定空端口）
node scripts/e2e-autostart.mjs         # 独立自动启动/退出清理测试（隔离 DSH_HOME）
```

目录：

```
packages/acp-core   ACP v1 类型 + stdio 传输 + JSON-RPC 对端（插件/适配器共用）
plugin/             Obsidian 插件（ACP 客户端 + UI）
adapter/            dsh-acp-adapter（ACP 服务端 ↔ DSH Web API）
scripts/            E2E 与调试探针
```

## 发布（GitHub Release，Obsidian 官方流程）

遵循 [Obsidian 官方 sample 插件](https://github.com/obsidianmd/obsidian-sample-plugin)的发布标准：

```bash
node scripts/version-bump.mjs 0.1.1   # 同步 manifest.json / versions.json / package.json
git commit -am "release 0.1.1"
git tag 0.1.1
git push --tags
```

推送 tag 会触发 `.github/workflows/release.yml`：CI 构建 → 校验 tag 与 manifest 版本一致 →
生成构建溯源认证（attestation）→ 创建 **draft release**，资产为 `main.js`、`manifest.json`、
`styles.css`（另附 `adapter.cjs`）。审核发布后在 Obsidian 社区插件流程中提交。

## 已知限制（v0.1）

- `mcpServers` 参数要求传空数组（DSH 使用自身的 MCP 客户端）。
- agent 提问（`ask_user_question`，如 plan 审批）暂以「可见提示 + 自动取消」处理；elicitation 支持计划在后续版本加入。
- 终端能力未启用（`terminal` capability 为 false；DSH 的命令执行发生在 DSH 进程内，通过工具卡片展示）。
- 删除会话仅从插件本地列表移除，DSH 端会话仍保留。
- 权限预设（read-only / workspace-write / danger-full-access）跟随 DSH 自身设置，默认 `workspace-write` 允许 agent 直接写 vault。
