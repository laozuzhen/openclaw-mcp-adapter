# 🔍 让 Channel 使用 TUI 模式的可行性分析

## 问题

用户希望让除了 main 之外的其他 Agent（bot2、xianyu 等）也使用 TUI 的工具调用方式（实时构建工具列表），以便能看到运行时注册的 MCP 工具。

---

## 核心差异回顾

### TUI 会话（main agent）

**工具调用路径**：
```
用户消息 → Gateway HTTP /tools/invoke
  ↓
handleToolInvokeHttp()
  ↓
createOpenClawTools() ← 每次调用都实时构建
  ↓
resolvePluginTools() ← 从插件注册表实时获取
  ↓
执行工具
```

**关键代码**：`moltbot-repo/src/gateway/tools-invoke-http.ts` 第 249 行

```typescript
// 每次 HTTP 请求都重新构建工具列表
const allTools = createOpenClawTools({
  agentSessionKey: sessionKey,
  // ...
});
```

### Agent Dispatch（Channel 插件）

**工具调用路径**：
```
Channel 消息 → Gateway RPC agent.run
  ↓
Agent 初始化（一次性）
  ↓
createOpenClawTools() ← 缓存工具列表
  ↓
Agent 循环处理消息（使用缓存的工具列表）
```

**关键代码**：Agent 初始化时调用一次 `createOpenClawTools()`，后续不再调用。

---

## 方案分析

### 方案 A：修改 Agent Dispatch 为每次消息都重新构建工具列表（不推荐）

**思路**：
- 修改 Agent 的工具获取逻辑
- 每次处理消息时都调用 `createOpenClawTools()`
- 类似 TUI 的实时构建方式

**实现难度**：
- 🔴 **高** - 需要修改 OpenClaw 核心代码
- 需要修改 Agent 的初始化和消息处理流程
- 需要确保不破坏现有的性能优化

**性能影响**：
- ❌ **严重** - 高频消息处理场景下性能会大幅下降
- Channel 插件可能每分钟处理 100+ 条消息
- 每次都重新构建工具列表会导致：
  - CPU 占用增加
  - 内存分配增加
  - 响应延迟增加

**OpenClaw 设计哲学冲突**：
- ❌ 违背了 OpenClaw 的性能优化设计
- TUI 和 Agent Dispatch 的差异是**有意为之**的设计决策
- 不太可能被 OpenClaw 官方接受

**结论**：
- ❌ **不推荐** - 性能影响太大，违背设计哲学

---

### 方案 B：让 Channel 通过 Gateway HTTP /tools/invoke 调用工具（可行但复杂）

**思路**：
- Channel 插件不直接使用 Agent 的工具列表
- 而是通过 Gateway HTTP API `/tools/invoke` 调用工具
- 这样就能利用 TUI 的实时构建机制

**架构变更**：

```
原架构：
Channel 消息 → Agent (缓存工具列表) → 执行工具

新架构：
Channel 消息 → Agent (缓存工具列表) → 发现需要调用工具
  ↓
  调用 Gateway HTTP /tools/invoke (实时构建工具列表)
  ↓
  执行工具 → 返回结果给 Agent
```

**实现步骤**：

1. **修改 Agent 的工具执行逻辑**：

```typescript
// 在 Agent 的工具执行前，检查是否是 MCP 工具
if (toolName.startsWith('mcp_')) {
  // 通过 HTTP API 调用工具（实时构建）
  const result = await fetch('http://localhost:3000/tools/invoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${gatewayToken}`
    },
    body: JSON.stringify({
      tool: toolName,
      args: toolArgs,
      sessionKey: sessionKey
    })
  });
  return await result.json();
} else {
  // 使用缓存的工具列表（原有逻辑）
  return await cachedTool.execute(toolArgs);
}
```

2. **配置 MCP 工具标记**：

在配置文件中标记哪些工具需要实时构建：

```json
{
  "plugins": {
    "entries": {
      "mcp-adapter": {
        "config": {
          "useDynamicToolResolution": true
        }
      }
    }
  }
}
```

**优点**：
- ✅ 能看到运行时注册的 MCP 工具
- ✅ 不影响其他工具的性能（只有 MCP 工具走 HTTP）
- ✅ 不需要修改 OpenClaw 核心的 Agent 初始化逻辑

**缺点**：
- ❌ 实现复杂，需要修改 Agent 的工具执行逻辑
- ❌ 增加了 HTTP 调用开销（每次 MCP 工具调用都需要 HTTP 请求）
- ❌ 需要处理认证和权限问题
- ❌ 可能与 OpenClaw 的设计哲学冲突

**性能影响**：
- ⚠️ **中等** - 只有 MCP 工具调用会有额外的 HTTP 开销
- 其他工具仍然使用缓存，性能不受影响

**结论**：
- ⚠️ **可行但不推荐** - 实现复杂，维护成本高

---

### 方案 C：配置文件预定义工具 + 同步注册 + 懒连接（强烈推荐）

**思路**：
- 在配置文件中预定义 MCP 工具列表
- 插件加载时**同步注册所有工具**
- Agent 初始化时就能看到所有工具（缓存的工具列表包含 MCP 工具）
- 首次调用时**懒连接** MCP 服务器

**架构**：

```
插件加载（Gateway 启动时）：
  ↓
读取配置文件中的工具列表
  ↓
同步注册所有工具（使用 factory 函数）
  ↓
Agent 初始化
  ↓
createOpenClawTools() ← 缓存工具列表（包含 MCP 工具）
  ↓
Channel 消息处理（使用缓存的工具列表）
  ↓
首次调用 MCP 工具时懒连接 MCP 服务器
```

**配置文件格式**：

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

**实现示例**：

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

**优点**：
- ✅ **所有 Agent 都能看到 MCP 工具**（包括 Channel 插件）
- ✅ **符合 OpenClaw 的设计模式**（同步注册）
- ✅ **性能好**（Agent 缓存工具列表，无额外开销）
- ✅ **避免冷启动问题**（懒连接）
- ✅ **实现简单**，不需要修改 OpenClaw 核心代码
- ✅ **维护成本低**

**缺点**：
- ⚠️ 需要手动配置工具列表（可以通过工具发现脚本自动化）
- ⚠️ 新增 MCP 工具需要更新配置并重启 Gateway

**性能影响**：
- ✅ **无** - 与原有的工具调用性能一致

**结论**：
- ✅ **强烈推荐** - 最佳方案

---

## 方案对比

| 方案 | 可行性 | 性能影响 | 实现复杂度 | 维护成本 | 推荐度 |
|------|--------|----------|-----------|----------|--------|
| **A. 修改 Agent Dispatch** | ❌ 低 | ❌ 严重 | 🔴 高 | 🔴 高 | ❌ 不推荐 |
| **B. HTTP 调用工具** | ⚠️ 中 | ⚠️ 中等 | 🟡 中 | 🟡 中 | ⚠️ 可行但不推荐 |
| **C. 配置预定义 + 懒连接** | ✅ 高 | ✅ 无 | 🟢 低 | 🟢 低 | ✅ 强烈推荐 |

---

## 推荐方案

**采用方案 C：配置文件预定义工具 + 同步注册 + 懒连接**

### 为什么不让 Channel 使用 TUI 模式？

1. **性能考虑**：
   - TUI 会话：低频交互（1-10 次/分钟），可以接受实时构建的开销
   - Channel 插件：高频自动化（可能 100+ 次/分钟），必须缓存以避免性能问题

2. **设计哲学**：
   - OpenClaw 的 TUI vs Agent Dispatch 差异是**有意为之**的设计决策
   - 修改这个设计会违背 OpenClaw 的性能优化原则

3. **实现复杂度**：
   - 让 Channel 使用 TUI 模式需要大量修改核心代码
   - 配置预定义方案只需要修改插件代码，不影响核心

4. **维护成本**：
   - 修改核心代码需要跟随 OpenClaw 版本更新
   - 配置预定义方案是插件级别的修改，维护成本低

### 实施计划

1. **修改 MCP Adapter 插件**：
   - 添加配置 schema，支持预定义工具列表
   - 修改注册逻辑，同步注册所有预定义工具
   - 实现懒连接机制

2. **提供工具发现脚本**：
   - 实现 `openclaw mcp-adapter discover` 命令
   - 自动连接 MCP 服务器，获取工具列表
   - 生成配置片段

3. **更新文档**：
   - 说明配置格式和工具发现流程
   - 提供示例配置

4. **测试验证**：
   - 验证所有 Agent 都能看到工具
   - 验证懒连接机制正常工作
   - 验证性能

---

## 结论

**不建议让 Channel 使用 TUI 模式**，原因：

1. **性能影响严重** - 高频消息处理场景下性能会大幅下降
2. **违背设计哲学** - OpenClaw 的 TUI vs Agent Dispatch 差异是有意为之的
3. **实现复杂度高** - 需要修改核心代码，维护成本高

**推荐方案**：

采用**配置文件预定义工具 + 同步注册 + 懒连接**的方案，这样：
- ✅ 所有 Agent 都能看到 MCP 工具
- ✅ 性能不受影响
- ✅ 实现简单，维护成本低
- ✅ 符合 OpenClaw 的设计模式

---

## 参考资料

- [PLUGIN_RELOAD_RESEARCH.md](./PLUGIN_RELOAD_RESEARCH.md)
- [MAIN_AGENT_MYSTERY_SOLVED.md](./MAIN_AGENT_MYSTERY_SOLVED.md)
- [TOOL_REGISTRATION_SCOPE_ANALYSIS.md](./TOOL_REGISTRATION_SCOPE_ANALYSIS.md)
