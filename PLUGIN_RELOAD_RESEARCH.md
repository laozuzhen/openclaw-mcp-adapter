# 🔄 OpenClaw 插件热重载调研报告

## 调研目标

调查 OpenClaw 是否支持插件热重载（配置变更后自动重新加载插件），以及如何让 MCP Adapter 的工具在所有 Agent 中可用。

---

## 核心发现

### 1. OpenClaw 配置热重载机制

**官方文档明确说明**：

> Config changes require a gateway restart.
> 
> — [OpenClaw Plugin Documentation](https://molty.finna.ai/docs/tools/plugin)

**结论**：
- ❌ OpenClaw **不支持插件配置热重载**
- ✅ 配置变更后**必须重启 Gateway**
- ⚠️ 有用户报告配置自动重载会导致 Gateway 崩溃（[AnswerOverflow](https://www.answeroverflow.com/m/1470915683440398388)）

### 2. 为什么 main agent 能看到后注册的工具？

**答案**：TUI 会话 vs Agent Dispatch 的设计差异

#### TUI 会话（main agent 使用）

**时序：**
```
T1: Gateway 启动，加载插件
T2: TUI 连接到 Gateway
T3: 用户在 TUI 中发送消息
T4: Gateway 调用 createOpenClawTools() ← 实时构建工具列表
T5: service.start() 异步连接 MCP，注册工具 ✅ 已完成
T6: 用户再次发送消息
T7: Gateway 再次调用 createOpenClawTools() ← 看到新注册的工具
```

**关键特性：**
- TUI 会话**每次工具调用**都重新调用 `createOpenClawTools()`
- `createOpenClawTools()` 内部调用 `resolvePluginTools()`
- `resolvePluginTools()` 从插件注册表中**实时获取**当前已注册的工具
- 因此能看到运行时注册的 MCP 工具

**代码证据**：`moltbot-repo/src/gateway/tools-invoke-http.ts` 第 249 行

```typescript
// 每次 HTTP 请求都重新构建工具列表
const allTools = createOpenClawTools({
  agentSessionKey: sessionKey,
  // ...
});
```

#### Agent Dispatch（Channel 插件使用）

**时序：**
```
T1: Gateway 启动，加载插件
T2: Agent 初始化，调用 createOpenClawTools() ← 缓存工具列表
T3: service.start() 异步连接 MCP，注册工具 ❌ 太晚了
T4: Channel 收到消息，使用缓存的工具列表 ← 看不到 MCP 工具
```

**关键特性：**
- Agent 在初始化时调用 `createOpenClawTools()` 并**缓存工具列表**
- 后续消息处理使用缓存的工具列表
- 不会重新调用 `resolvePluginTools()`
- 因此看不到后注册的 MCP 工具

**代码证据**：`moltbot-repo/src/agents/openclaw-tools.ts`

```typescript
export function createOpenClawTools(options?: {
  // ...
}): AnyAgentTool[] {
  // ...
  
  // 调用 resolvePluginTools 获取插件工具
  const pluginTools = resolvePluginTools({
    context: { /* ... */ },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
```

**Agent 初始化时调用一次，后续不再调用。**

### 3. 为什么会有这个设计差异？

#### 性能考虑

| 场景 | 频率 | 策略 | 原因 |
|------|------|------|------|
| **TUI 会话** | 低频（1-10 次/分钟） | 实时构建工具列表 | 用户交互频率低，可以接受实时构建的开销 |
| **Agent Dispatch** | 高频（可能 100+ 次/分钟） | 缓存工具列表 | 自动化处理，高频率消息，必须缓存以避免性能问题 |

#### 设计意图

1. **TUI 会话（交互式）**
   - 用户直接与 Gateway 交互
   - 每次工具调用都是独立的 HTTP 请求
   - 可以实时获取最新的工具列表
   - 性能影响小

2. **Agent Dispatch（自动化）**
   - Channel 插件自动处理消息
   - 高频率消息处理
   - 缓存工具列表提高性能
   - 避免每次消息都重新构建工具列表

---

## 相关问题调研

### MCP 服务器支持问题

**发现**：OpenClaw 的 ACP（Agent Client Protocol）层明确禁用了 MCP 支持

**证据来源**：[Gist by Rapha-btc](https://gist.github.com/Rapha-btc/527d08acc523d6dcdb2c224fe54f3f39)

```javascript
// dist/acp/translator.js
mcpCapabilities: {
    http: false,
    sse: false,
}

// MCP servers passed during session creation are silently ignored:
if (params.mcpServers.length > 0) {
    this.log(`ignoring ${params.mcpServers.length} MCP servers`);
}
```

**mcporter 的问题**：
- OpenClaw 自带 `mcporter` 作为 skill，通过 CLI 子进程调用 MCP 工具
- 每次调用都会冷启动 MCP 服务器（~2.4s 延迟）
- 对于需要即时响应的工具（如钱包余额查询）不可用

**社区解决方案**：
- 绕过 OpenClaw，直接构建 Telegram Bot
- 使用 `@modelcontextprotocol/sdk` 客户端维持持久化 stdio 连接
- MCP 服务器启动一次后保持热连接，工具调用延迟降至毫秒级

---

## 解决方案

### 方案 A：配置文件预定义工具 + 同步注册 + 懒连接（推荐）

**思路**：
1. 在配置文件中预定义 MCP 工具列表
2. 插件加载时**同步注册所有工具**（使用 factory 函数）
3. 首次调用时**懒连接** MCP 服务器
4. 提供工具发现脚本自动更新配置

**优点**：
- ✅ 所有 Agent（包括 Channel 插件）都能看到工具
- ✅ 符合 OpenClaw 的设计模式（同步注册）
- ✅ 性能好（Agent 缓存工具列表）
- ✅ 避免冷启动问题（懒连接）

**实现步骤**：

1. **配置文件格式**：

```json
{
  "plugins": {
    "entries": {
      "mcp-adapter": {
        "enabled": true,
        "config": {
          "servers": {
            "filesystem": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
              "tools": [
                "read_file",
                "write_file",
                "list_directory"
              ]
            }
          }
        }
      }
    }
  }
}
```

2. **插件加载时同步注册**：

```typescript
export default function register(api: OpenClawPluginApi) {
  const config = api.config.plugins?.entries?.["mcp-adapter"]?.config;
  
  // 同步注册所有预定义的工具
  for (const [serverName, serverConfig] of Object.entries(config.servers)) {
    for (const toolName of serverConfig.tools) {
      api.registerTool((ctx) => ({
        name: `mcp_${serverName}_${toolName}`,
        description: `MCP tool: ${toolName} from ${serverName}`,
        parameters: { /* ... */ },
        execute: async (callId, args) => {
          // 懒连接：首次调用时才连接 MCP 服务器
          const client = await getOrCreateClient(serverName, serverConfig);
          return await client.callTool(toolName, args);
        }
      }), { name: `mcp_${serverName}_${toolName}` });
    }
  }
}
```

3. **懒连接实现**：

```typescript
const clientCache = new Map<string, MCPClient>();

async function getOrCreateClient(serverName: string, config: ServerConfig) {
  if (!clientCache.has(serverName)) {
    const client = new MCPClient(config);
    await client.connect();
    clientCache.set(serverName, client);
  }
  return clientCache.get(serverName)!;
}
```

4. **工具发现脚本**：

```bash
# 自动发现 MCP 服务器的工具列表
openclaw mcp-adapter discover filesystem
# 输出：
# Found 3 tools:
#   - read_file
#   - write_file
#   - list_directory
# 
# Add to config:
#   plugins.entries.mcp-adapter.config.servers.filesystem.tools = [...]
```

### 方案 B：利用 TUI 会话的实时构建特性（不推荐）

**思路**：只在 TUI 会话中使用 MCP 工具

**问题**：
- ❌ Channel 插件（飞书、钉钉、咸鱼）仍然看不到工具
- ❌ 用户体验差，限制了使用场景
- ❌ 不符合用户期望（希望所有 Agent 都能用）

### 方案 C：修改 OpenClaw 核心（不现实）

**思路**：修改 OpenClaw 核心代码，支持异步插件加载和工具动态注册

**问题**：
- ❌ 需要修改 OpenClaw 核心代码
- ❌ 需要提交 PR 并等待合并
- ❌ 可能破坏现有的性能优化设计
- ❌ 不符合 OpenClaw 的设计哲学（同步加载）

---

## 推荐实施方案

**采用方案 A：配置文件预定义工具 + 同步注册 + 懒连接**

### 实施计划

1. **修改 MCP Adapter 插件**：
   - 添加配置 schema，支持预定义工具列表
   - 修改注册逻辑，同步注册所有预定义工具
   - 实现懒连接机制，首次调用时才连接 MCP 服务器

2. **提供工具发现脚本**：
   - 实现 `openclaw mcp-adapter discover` 命令
   - 自动连接 MCP 服务器，获取工具列表
   - 生成配置片段，方便用户添加到配置文件

3. **更新文档**：
   - 说明配置格式和工具发现流程
   - 提供示例配置
   - 说明懒连接机制和性能优化

4. **测试验证**：
   - 验证所有 Agent（main、bot2、xianyu 等）都能看到工具
   - 验证懒连接机制正常工作
   - 验证性能（首次调用延迟、后续调用延迟）

---

## 结论

1. **OpenClaw 不支持插件热重载**
   - 配置变更后必须重启 Gateway
   - 这是设计决策，不是 bug

2. **main agent 能看到后注册的工具是因为 TUI 会话实时构建工具列表**
   - TUI 会话：每次工具调用都重新构建工具列表
   - Agent Dispatch：Agent 初始化时缓存工具列表
   - 这是性能优化的设计差异

3. **解决方案：配置文件预定义工具 + 同步注册 + 懒连接**
   - 符合 OpenClaw 的设计模式
   - 所有 Agent 都能看到工具
   - 性能好，避免冷启动问题

4. **下一步行动**：
   - 实现方案 A
   - 提供工具发现脚本
   - 更新文档和示例配置
   - 测试验证

---

## 参考资料

- [OpenClaw Plugin Documentation](https://molty.finna.ai/docs/tools/plugin)
- [OpenClaw Can't Use MCP Servers Natively — How We Solved It](https://gist.github.com/Rapha-btc/527d08acc523d6dcdb2c224fe54f3f39)
- [MAIN_AGENT_MYSTERY_SOLVED.md](./MAIN_AGENT_MYSTERY_SOLVED.md)
- [ASYNC_PLUGIN_RESEARCH.md](./ASYNC_PLUGIN_RESEARCH.md)
- [TOOL_REGISTRATION_SCOPE_ANALYSIS.md](./TOOL_REGISTRATION_SCOPE_ANALYSIS.md)
