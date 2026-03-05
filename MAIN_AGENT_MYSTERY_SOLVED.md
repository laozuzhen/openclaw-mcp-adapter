# 🔍 为什么 main agent 能看到后注册的工具？

## 问题

用户观察到：
- MCP Adapter 在 `service.start()` 中异步注册工具（Agent 初始化之后）
- 其他 Agent（bot2、xianyu 等）看不到 MCP 工具
- **但 main agent 能看到 MCP 工具** ❓

## 答案：TUI 会话 vs Agent Dispatch 的区别

### 关键发现

**证据来源**：`moltbot-repo/src/gateway/tools-invoke-http.ts` 第 249-251 行

```typescript
// Build tool list (core + plugin tools).
const allTools = createOpenClawTools({
  agentSessionKey: sessionKey,
  agentChannel: messageChannel ?? undefined,
  agentAccountId: accountId,
  // ...
  pluginToolAllowlist: collectExplicitAllowlist([...]),
});
```

### 两种工具获取方式

#### 1. TUI 会话（main agent 使用）

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

**关键：**
- TUI 会话**每次调用工具时**都重新调用 `createOpenClawTools()`
- `createOpenClawTools()` 内部调用 `resolvePluginTools()`
- `resolvePluginTools()` 从插件注册表中**实时获取**当前已注册的工具
- 因此能看到后注册的 MCP 工具

#### 2. Agent Dispatch（Channel 插件使用）

**时序：**
```
T1: Gateway 启动，加载插件
T2: Agent 初始化，调用 createOpenClawTools() ← 缓存工具列表
T3: service.start() 异步连接 MCP，注册工具 ❌ 太晚了
T4: Channel 收到消息，使用缓存的工具列表 ← 看不到 MCP 工具
```

**关键：**
- Agent 在初始化时调用 `createOpenClawTools()` 并**缓存工具列表**
- 后续消息处理使用缓存的工具列表
- 不会重新调用 `resolvePluginTools()`
- 因此看不到后注册的 MCP 工具

## 代码证据

### TUI 会话：每次实时构建

**文件**：`moltbot-repo/src/gateway/tools-invoke-http.ts`

```typescript
export async function handleToolInvokeHttp(params: {
  req: IncomingMessage;
  res: ServerResponse;
  // ...
}) {
  // ...
  
  // 每次 HTTP 请求都重新构建工具列表
  const allTools = createOpenClawTools({
    agentSessionKey: sessionKey,
    // ...
  });
  
  // 查找并执行工具
  const tool = allTools.find((t) => t.name === toolName);
  // ...
}
```

### Agent Dispatch：初始化时缓存

**文件**：`moltbot-repo/src/agents/openclaw-tools.ts`

```typescript
export function createOpenClawTools(options?: {
  // ...
}): AnyAgentTool[] {
  // ...
  
  // 调用 resolvePluginTools 获取插件工具
  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      // ...
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
```

**Agent 初始化时调用一次，后续不再调用。**

## 为什么会有这个差异？

### 设计意图

1. **TUI 会话（交互式）**
   - 用户直接与 Gateway 交互
   - 每次工具调用都是独立的 HTTP 请求
   - 可以实时获取最新的工具列表
   - 性能影响小（用户交互频率低）

2. **Agent Dispatch（自动化）**
   - Channel 插件自动处理消息
   - 高频率消息处理
   - 缓存工具列表提高性能
   - 避免每次消息都重新构建工具列表

### 性能考虑

```typescript
// TUI 会话：低频率，可以实时构建
用户发送消息 (1-10 次/分钟)
  ↓
createOpenClawTools() ← 可接受的开销

// Agent Dispatch：高频率，必须缓存
Channel 收到消息 (可能 100+ 次/分钟)
  ↓
使用缓存的工具列表 ← 避免性能问题
```

## 解决方案

### 方案 J：利用 TUI 会话的实时构建特性（不推荐）

**思路：只在 TUI 会话中使用 MCP 工具**

**问题：**
- Channel 插件（飞书、钉钉、咸鱼）仍然看不到工具
- 用户体验差，限制了使用场景

### 方案 K：在插件加载时同步注册（推荐）

**思路：配置文件预定义工具 + 懒连接**

这就是我们之前讨论的方案 G/I：
1. 在配置文件中预定义工具列表
2. 插件加载时同步注册所有工具
3. 首次调用时懒连接 MCP 服务器

**优点：**
- ✅ 所有 Agent（包括 Channel 插件）都能看到工具
- ✅ 符合 OpenClaw 的设计模式
- ✅ 性能好（缓存工具列表）

## 结论

**main agent 能看到后注册的工具，是因为：**

1. **TUI 会话使用实时工具构建**
   - 每次工具调用都重新调用 `createOpenClawTools()`
   - 能看到运行时注册的工具

2. **Agent Dispatch 使用缓存工具列表**
   - Agent 初始化时调用一次 `createOpenClawTools()`
   - 后续使用缓存，看不到后注册的工具

3. **这是设计差异，不是 bug**
   - TUI：低频交互，实时构建
   - Agent：高频自动化，缓存优化

**推荐方案：**
- 在配置文件中预定义工具列表
- 插件加载时同步注册
- 首次调用时懒连接 MCP
- 所有 Agent 都能看到工具
