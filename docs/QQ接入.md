# 把 TA 接进 QQ（NapCat + LangBot + 勿忘我）

接好之后：

- QQ 私聊里，你问 TA 就答；TA 记住的事和 dsh 里是**同一份记忆**。
- 群聊里，**只有 @ TA 或者以 TA 的名字开头**说话，TA 才会回；其他人聊天 TA 完全不看，一个 token 都不花。
- TA 会时不时**主动来私聊你**：问问你前几天说的事后来怎么样了、饭点问你吃了没、那年今天、周日晚上的「这周我记住了你的这些事」。

整体就三块积木，都装在**同一台电脑**上：

```
QQ  ⇄  NapCat（登录 QQ 号）  ⇄  LangBot（让 TA 会聊天）  ⇄  DeepSeek
                                      │
                                      └── 勿忘我（记忆 + 主动找你）
```

> 下面写到的菜单名字，以你装的版本为准；对不上的话截图给我看。

---

## 第 1 步：装 NapCat，让一个 QQ 号上线

1. 准备一个给 TA 用的 QQ 小号。
2. 按 NapCat 官方文档安装并扫码登录（Windows 有一键包）。
3. 打开 NapCat 的 WebUI → **网络配置**，新建两个：
   - **HTTP 服务器**：端口 `3000`，设置一个 **Token**（随便一串字母数字，记下来）。勿忘我用它来「主动发消息」。
   - **WebSocket 客户端（反向 WS）**：地址填 LangBot 给的地址（第 2 步会看到，一般是 `ws://127.0.0.1:2280/ws`）。LangBot 用它来收发聊天消息。

## 第 2 步：装 LangBot，接上 DeepSeek

1. 按 LangBot 官方文档安装。**建议直接装在电脑上，不要用 Docker**（用 Docker 的话，里面的 `127.0.0.1` 指的是容器自己，连不到勿忘我）。
2. 打开 LangBot 的 WebUI：
   - **模型**：添加 DeepSeek，填你的 DeepSeek API Key，选 `deepseek-chat`，打开「工具调用 / Function Calling」。
   - **机器人**：添加一个 OneBot v11（aiocqhttp）机器人，它会显示反向 WS 的地址，填回 NapCat 第 1 步。
3. **流水线（Pipeline）**设置：
   - **AI 运行器**：用内置 Agent，模型选刚才的 DeepSeek。
   - **人设 / 系统提示词**：把人设卡（比如 `绯语-人设卡.json`）里 `system_prompt`、`description`、`personality`、`scenario` 的内容粘进去。
   - **群聊响应规则**（最重要，省 token 全靠它）：
     | 选项 | 填什么 | 意思 |
     |---|---|---|
     | 被 @ 时响应（at） | **开** | 有人 @ TA 才回 |
     | 前缀（prefix） | `绯语` | 消息以「绯语」开头也会回 |
     | 随机响应概率（random） | **0** | 其他消息一律不理 |
     | 正则（regexp） | 留空 | |
   - **私聊**：默认每条都回，不用改。
   - **对话历史 / 上下文轮数**：群聊建议调小（比如 4 轮），也能省 token。

## 第 3 步：开勿忘我，并接进 LangBot

1. 在电脑上开一个终端，填上你自己的信息后运行：

   **Windows（PowerShell）：**
   ```powershell
   $env:DEEPSEEK_API_KEY="你的 DeepSeek Key"
   $env:FMN_QQ="你自己的 QQ 号"
   $env:FMN_ONEBOT_URL="http://127.0.0.1:3000"
   $env:FMN_ONEBOT_TOKEN="第 1 步设置的 Token"
   npx -y dsh-forget-me-not serve
   ```

   **Mac / Linux：**
   ```bash
   DEEPSEEK_API_KEY=你的Key FMN_QQ=你的QQ号 FMN_ONEBOT_URL=http://127.0.0.1:3000 FMN_ONEBOT_TOKEN=你的Token \
     npx -y dsh-forget-me-not serve
   ```

   看到「主动聊天：开」就对了。这个窗口不要关（关了 TA 就不会主动找你，记忆也连不上）。

2. LangBot WebUI → **插件 / MCP 管理** → 添加 MCP 服务器：
   - 类型选 **远程（HTTP / Streamable HTTP）**
   - 地址：`http://127.0.0.1:7777/mcp`
   - 点「测试」，能看到 5 个工具（`memory_wake`、`memory_remember`、`memory_recall`、`portrait_update`、`persona_reflect`）就成功了，再点开关启用。
   - 回到流水线，在扩展里允许 Agent 使用这个 MCP 服务器。

3. 浏览器打开 <http://127.0.0.1:7777> 就是记忆星环；在 dsh 里装了插件的话，dsh 里的「记忆」也是同一份。

## 主动聊天可以调

在第 3 步的命令前面多加几个变量就行：

| 变量 | 默认 | 意思 |
|---|---|---|
| `FMN_PROACTIVE_HOURS` | `9-23` | 只在这个时间段来找你 |
| `FMN_PROACTIVE_MAX` | `3` | 每天最多来几次 |
| `FMN_PROACTIVE_GAP` | `3` | 两次之间至少隔几小时 |

还有几条规矩是写死的，让 TA 不烦人：

- 你正在跟 TA 聊（最近 40 分钟有对话）时不打扰；
- 连着两次你都没理，那天就最多来一次；
- 不会准点来，时间带一点随机，像真人一样。

想先看看 TA 会说什么、又不想真的发出去：

```bash
npx -y dsh-forget-me-not proactive --once --dry-run
```

## 花多少钱

- 群里：只有 @ 或叫名字才调用模型，其他消息零花费。
- 主动聊天：每次一条消息，一天最多 3 次，每次大约 1～2 千 token。
- 自动总结记忆：攒几轮再一起总结；聊到生日、过敏、喜欢讨厌、约定这类事才会马上总结。
