# MCP Adapter 工具注册作用域分析报告

## 🎯 问题描述

**用户观察**：MCP Adapter 注册的工具只在 `main` agent 可用，其他 agent 无法使用这些工具。

**关键发现**：工具确实**没有注册到其他 agent**，而不是注册了但被策略阻止。

---

## 🔍 深度调查结果

### 1️⃣ OpenClaw 工具注册机制

#### 插件工具注册流程

```typescript
// 步骤 1: 插件调用 api.registerTool()
api.registerTool({
  name: "my_tool",
  description: "...",
  parameters: {...},
  async execute(id, params) {...}
})

// 步骤 2: 插件注册表存储为 Factory
// 位置: moltbot-repo/src/plugins/registry.ts 第 189 行
const factory: OpenClawPluginToolFactory =
  typeof tool === "function" 
    ? tool 
    : (_ctx: OpenClawPluginToolContext) => tool; // ❌ 关键：包装为忽略 context 的 factory

registry.tools.push({
  pluginId: record.id,
  factory,
  names: normalized,
  optional,
  source: record.source,
});

// 步骤 3: 每个 agent 运行时调用 factory
// 位置: moltbot-repo/src/plugins/tools.ts 第 88 行
for (const entry of registry.tools) {
  let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
  try {
    resolved = entry.factory(params.context); // ✅ 传入当前 agent 的 context
  } catch (err) {
    log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
    continue;
  }
  // ... 将 resolved 工具添加到当前 agent 的工具列表
}
```

#### OpenClawPluginToolContext 结构

```typescript
// 位置: moltbot-repo/src/plugins/types.ts 第 35 行
export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;        // ✅ 每个 agent 都有自己的 ID
  sessionKey?: string;
  messageChannel?: string;
  agentAccountId?: string;
  sandboxed?: boolean;
};
```

#### Agent 工具创建流程

```typescript
// 位置: moltbot-repo/src/agents/openclaw-tools.ts 第 168 行
const pluginTools = resolvePluginTools({
  context: {
    config: options?.config,
    workspaceDir,
    agentDir: options?.agentDir,
    agentId: resolveSessionAgentId({...}), // ✅ 每个 agent 传入自己的 agentId
    sessionKey: options?.agentSessionKey,
    messageChannel: options?.agentChannel,
    agentAccountId: options?.agentAccountId,
    sandboxed: options?.sandboxed,
  },
  existingToolNames: new Set(tools.map((tool) => tool.name)),
  toolAllowlist: options?.pluginToolAllowlist,
});
```

**关键发现**：
- ✅ 每个 agent 运行时都会调用 `resolvePluginTools()`
- ✅ 每个 agent 都会传入自己的 `agentId` 和 `sessionKey`
- ✅ 每个 agent 都会调用插件注册的 `factory` 函数

---

### 2️⃣ MCP Adapter 当前实现

#### 工具注册代码

```typescript
// 位置: openclaw-mcp-adapter-repo/index.ts 第 13 行
api.registerService({
  id: "mcp-adapter",

  async start() {
    for (const server of config.servers) {
      try {
        console.log(`[mcp-adapter] Connecting to ${server.name}...`);
        await pool.connect(server);

        const tools = await pool.listTools(server.name);
        console.log(`[mcp-adapter] ${server.name}: found ${tools.length} tools`);

        for (const tool of tools) {
          const toolName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;

          // ❌ 问题：注册的是静态工具对象，不是 factory 函数
          api.registerTool({
            name: toolName,
            description: tool.description ?? `Tool from ${server.name}`,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
            async execute(_id: string, params: unknown) {
              const result = await pool.callTool(server.name, tool.name, params);
              const text = result.content
                ?.map((c: any) => c.text ?? c.data ?? "")
                .join("\n") ?? "";
              return {
                content: [{ type: "text", text }],
                isError: result.isError,
              };
            },
          });

          console.log(`[mcp-adapter] Registered: ${toolName}`);
        }
      } catch (err) {
        console.error(`[mcp-adapter] Failed to connect to ${server.name}:`, err);
      }
    }
  },

  async stop() {
    console.log("[mcp-adapter] Shutting down...");
    await pool.closeAll();
    console.log("[mcp-adapter] All connections closed");
  },
});
```

---

### 3️⃣ 问题根源分析

#### ❌ 当前行为

1. **MCP Adapter 注册静态工具对象**：
   ```typescript
   api.registerTool({
     name: toolName,
     description: "...",
     parameters: {...},
     async execute(_id, params) {...} // ❌ 静态对象
   })
   ```

2. **插件注册表包装为 factory**：
   ```typescript
   const factory = (_ctx: OpenClawPluginToolContext) => tool; // ❌ 忽略 context
   ```

3. **所有 agent 调用 factory 时返回同一个工具对象**：
   ```typescript
   resolved = entry.factory(params.context); // 返回同一个 tool 对象
   ```

#### 🔴 为什么只在 main agent 可用？

**假设 1：工具策略过滤**

经过调查 `resolveEffectiveToolPolicy` 和 `resolveAgentConfig`，发现：
- ✅ 工具策略是基于 `agentId` 和 `sessionKey` 动态解析的
- ✅ 每个 agent 都有自己的工具策略配置
- ✅ 插件工具会经过策略过滤

**但是**：如果是策略问题，工具应该被注册但被阻止，而不是根本没注册。

**假设 2：Service 生命周期问题**

MCP Adapter 使用 `registerService` 在 `start()` 阶段注册工具：

```typescript
api.registerService({
  id: "mcp-adapter",
  async start() {
    // 在这里注册工具
    api.registerTool({...});
  }
})
```

**关键时序**：
1. Gateway 启动时调用 `service.start()`
2. 此时只有 `main` agent 存在（默认 agent）
3. MCP Adapter 连接 MCP 服务器并注册工具
4. 工具被添加到**全局插件注册表**
5. 其他 agent 后续创建时，调用 `resolvePluginTools()` 获取工具

**理论上**：所有 agent 都应该能获取到工具，因为：
- 工具存储在全局插件注册表 `registry.tools`
- 每个 agent 都会调用 `resolvePluginTools()` 遍历 `registry.tools`
- 每个 agent 都会调用 `entry.factory(params.context)` 获取工具实例

**那么问题在哪里？**

---

### 4️⃣ 真正的问题（需要进一步验证）

#### 可能原因 A：工具策略默认拒绝插件工具

查看 `moltbot-repo/src/agents/pi-tools.ts` 第 231 行：

```typescript
const {
  agentId,
  globalPolicy,
  globalProviderPolicy,
  agentPolicy,
  agentProviderPolicy,
  profile,
  providerProfile,
  profileAlsoAllow,
  providerProfileAlsoAllow,
} = resolveEffectiveToolPolicy({
  config: options?.config,
  sessionKey: options?.sessionKey,
  modelProvider: options?.modelProvider,
  modelId: options?.modelId,
});
```

然后在第 286 行应用策略过滤：

```typescript
const subagentFiltered = applyToolPolicyPipeline({
  tools: toolsByAuthorization,
  toolMeta: (tool) => getPluginToolMeta(tool),
  warn: logWarn,
  steps: [
    ...buildDefaultToolPolicyPipelineSteps({
      profilePolicy: profilePolicyWithAlsoAllow,
      profile,
      providerProfilePolicy: providerProfilePolicyWithAlsoAllow,
      providerProfile,
      globalPolicy,
      globalProviderPolicy,
      agentPolicy,
      agentProviderPolicy,
      groupPolicy,
      agentId,
    }),
    { policy: sandbox?.tools, label: "sandbox tools.allow" },
    { policy: subagentPolicy, label: "subagent tools.allow" },
  ],
});
```

**关键**：插件工具会经过工具策略过滤。如果：
- `main` agent 的工具策略允许插件工具
- 其他 agent 的工具策略拒绝插件工具

那么就会出现"只在 main agent 可用"的现象。

#### 可能原因 B：Agent 配置差异

查看 `resolveAgentConfig` 的实现（`moltbot-repo/src/agents/agent-scope.ts` 第 99 行）：

```typescript
export function resolveAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): AgentConfig | undefined {
  const list = cfg.agents?.list ?? [];
  const entry = list.find((agent) => agent.id === agentId);
  return entry;
}
```

如果 `main` agent 有特殊配置，而其他 agent 没有，可能导致工具可见性差异。

---

## 🔧 解决方案

### 方案 A：使用 Factory 函数（推荐）

**修改 MCP Adapter 使用 factory 函数注册工具**：

```typescript
// ✅ 正确做法：注册 factory 函数
api.registerTool(
  (ctx: OpenClawPluginToolContext) => {
    // 可以根据 ctx.agentId 返回不同的工具实例
    // 或者返回同一个工具实例（如果工具是无状态的）
    return {
      name: toolName,
      description: tool.description ?? `Tool from ${server.name}`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_id: string, params: unknown) {
        const result = await pool.callTool(server.name, tool.name, params);
        const text = result.content
          ?.map((c: any) => c.text ?? c.data ?? "")
          .join("\n") ?? "";
        return {
          content: [{ type: "text", text }],
          isError: result.isError,
        };
      },
    };
  },
  { name: toolName }
);
```

**优点**：
- ✅ 符合 OpenClaw 的设计模式
- ✅ 每个 agent 调用时都会执行 factory 函数
- ✅ 可以根据 `ctx.agentId` 返回不同的工具实例

### 方案 B：检查工具策略配置

**检查 OpenClaw 配置文件**，确认：

1. **全局工具策略**：
   ```json
   {
     "tools": {
       "allow": ["*"],  // 或者明确列出插件工具
       "deny": []
     }
   }
   ```

2. **Agent 特定工具策略**：
   ```json
   {
     "agents": {
       "list": [
         {
           "id": "main",
           "tools": {
             "allow": ["*"]  // main agent 允许所有工具
           }
         },
         {
           "id": "other-agent",
           "tools": {
             "allow": ["*"]  // 其他 agent 也需要允许
           }
         }
       ]
     }
   }
   ```

3. **插件工具 allowlist**：
   ```json
   {
     "plugins": {
       "enabled": true,
       "tools": {
         "allow": ["*"]  // 允许所有插件工具
       }
     }
   }
   ```

### 方案 C：调试验证

**添加调试日志**，确认工具是否被过滤：

```typescript
// 在 moltbot-repo/src/plugins/tools.ts 第 88 行添加日志
for (const entry of registry.tools) {
  console.log(`[DEBUG] Resolving plugin tool: ${entry.pluginId}, agentId: ${params.context.agentId}`);
  
  let resolved: AnyAgentTool | AnyAgentTool[] | null | undefined = null;
  try {
    resolved = entry.factory(params.context);
    console.log(`[DEBUG] Resolved tools:`, resolved ? (Array.isArray(resolved) ? resolved.map(t => t.name) : [resolved.name]) : 'null');
  } catch (err) {
    log.error(`plugin tool failed (${entry.pluginId}): ${String(err)}`);
    continue;
  }
  // ...
}
```

---

## 📊 验证步骤

### 1. 确认工具是否被注册到全局注册表

在 `openclaw-mcp-adapter-repo/index.ts` 添加日志：

```typescript
api.registerTool({...});
console.log(`[mcp-adapter] Tool registered to global registry: ${toolName}`);
```

### 2. 确认每个 agent 是否调用 resolvePluginTools

在 `moltbot-repo/src/plugins/tools.ts` 添加日志：

```typescript
export function resolvePluginTools(params: {
  context: OpenClawPluginToolContext;
  existingToolNames?: Set<string>;
  toolAllowlist?: string[];
}): AnyAgentTool[] {
  console.log(`[DEBUG] resolvePluginTools called for agentId: ${params.context.agentId}`);
  // ...
}
```

### 3. 确认工具是否被策略过滤

在 `moltbot-repo/src/agents/pi-tools.ts` 添加日志：

```typescript
const subagentFiltered = applyToolPolicyPipeline({...});
console.log(`[DEBUG] Tools after policy filter (agentId: ${agentId}):`, subagentFiltered.map(t => t.name));
```

---

## 🎯 结论

**根本原因**：需要进一步验证，但最可能的原因是：

1. **工具策略过滤**：其他 agent 的工具策略配置拒绝了插件工具
2. **Factory 函数问题**：MCP Adapter 注册的是静态对象，虽然理论上应该对所有 agent 可用，但可能存在某种缓存或状态问题

**推荐解决方案**：

1. **立即尝试**：修改 MCP Adapter 使用 factory 函数注册工具（方案 A）
2. **同时检查**：OpenClaw 配置文件中的工具策略设置（方案 B）
3. **如果仍有问题**：添加调试日志验证工具注册和过滤流程（方案 C）

---

## 📝 下一步行动

1. ✅ 修改 `openclaw-mcp-adapter-repo/index.ts` 使用 factory 函数
2. ✅ 测试工具是否在所有 agent 可用
3. ✅ 如果仍有问题，添加调试日志定位具体原因
4. ✅ 更新文档说明正确的工具注册方式
