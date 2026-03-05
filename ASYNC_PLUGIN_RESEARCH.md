# OpenClaw 插件异步加载调研报告

## 调研目标

调查 OpenClaw 插件系统是否支持异步插件加载函数（async register function）。

## 调研结果

### ❌ 不支持异步插件加载

**证据来源**：`moltbot-repo/src/plugins/loader.ts` 第 800-810 行

```typescript
try {
  const result = register(api);
  if (result && typeof result.then === "function") {
    registry.diagnostics.push({
      level: "warn",
      pluginId: record.id,
      source: record.source,
      message: "plugin register returned a promise; async registration is ignored",
    });
  }
  registry.plugins.push(record);
  seenIds.set(pluginId, candidate.origin);
} catch (err) {
  // ...
}
```

### 关键发现

1. **插件加载器不等待 Promise**
   - 调用 `register(api)` 后立即检查返回值
   - 如果返回 Promise，只记录警告，不等待完成
   - 警告信息：`"plugin register returned a promise; async registration is ignored"`

2. **同步执行模型**
   - 插件加载是同步的
   - `register` 函数必须同步完成所有注册工作
   - 异步操作会被忽略

3. **设计意图**
   - OpenClaw 期望插件在加载时立即注册所有工具
   - 不支持延迟注册或异步初始化

## 对 MCP Adapter 的影响

### 方案 D（同步连接 MCP）不可行

**原因：**
```typescript
// ❌ 这样写会被警告并忽略
export default async function (api: any) {
  await pool.connect(server);  // 异步连接
  // 注册工具...
}
```

**OpenClaw 的行为：**
- 调用插件的默认导出函数
- 不等待 Promise 完成
- 记录警告：`"async registration is ignored"`
- 继续加载下一个插件

### 根本问题确认

**时序问题无法通过插件层面解决：**

```
T1: Gateway 启动，loadOpenClawPlugins() 同步加载所有插件
    ↓
    插件 register(api) 必须同步完成
    ↓
T2: Agent 初始化，调用 resolvePluginTools()
    ↓
    此时只能看到 T1 时注册的工具
    ↓
T3: service.start() 异步连接 MCP，注册工具 ❌ 太晚了
```

## 可行方案分析

### ✅ 方案 E：预连接 + 同步注册（推荐）

**思路：在插件加载前预先连接 MCP 服务器**

```typescript
// 在 service 外部预先连接
const pool = new McpClientPool();
const toolsCache = new Map();

// 同步连接并缓存工具列表
for (const server of config.servers) {
  try {
    // 使用同步方式或在插件加载前完成连接
    const tools = await pool.listTools(server.name);
    toolsCache.set(server.name, tools);
  } catch (err) {
    console.error(`Failed to connect: ${err}`);
  }
}

// 插件加载时同步注册
export default function (api: any) {
  for (const [serverName, tools] of toolsCache) {
    for (const tool of tools) {
      api.registerTool((ctx) => ({
        name: tool.name,
        // ...
      }));
    }
  }
}
```

**问题：**
- 插件模块是同步加载的，无法在模块顶层 await
- 需要在插件外部预先连接

### ✅ 方案 F：懒加载工具（推荐）

**思路：注册占位工具，首次调用时连接 MCP**

```typescript
export default function (api: any) {
  const pool = new McpClientPool();
  const connectionPromises = new Map();

  for (const server of config.servers) {
    // 立即注册占位工具（同步）
    api.registerTool((ctx) => ({
      name: `${server.name}_call`,
      description: `Call MCP tools from ${server.name}`,
      parameters: {
        type: "object",
        properties: {
          tool: { type: "string", description: "Tool name" },
          params: { type: "object", description: "Tool parameters" }
        },
        required: ["tool"]
      },
      async execute(_id: string, args: any) {
        // 首次调用时连接
        if (!connectionPromises.has(server.name)) {
          connectionPromises.set(
            server.name,
            pool.connect(server)
          );
        }
        await connectionPromises.get(server.name);
        
        // 调用真正的 MCP 工具
        return await pool.callTool(server.name, args.tool, args.params);
      }
    }));
  }
}
```

**优点：**
- 同步注册，符合 OpenClaw 要求
- 所有 Agent 都能看到工具
- 首次调用时才连接，不阻塞启动

**缺点：**
- Agent 看不到具体的工具列表
- 需要手动指定工具名
- 用户体验较差

### ✅ 方案 G：配置文件预定义工具（最佳）

**思路：在配置文件中预定义 MCP 工具列表**

```json
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"],
      "tools": [
        {
          "name": "read_file",
          "description": "Read file contents",
          "inputSchema": { ... }
        },
        {
          "name": "write_file",
          "description": "Write file contents",
          "inputSchema": { ... }
        }
      ]
    }
  ]
}
```

```typescript
export default function (api: any) {
  const pool = new McpClientPool();
  const connectionPromises = new Map();

  for (const server of config.servers) {
    // 从配置文件读取工具列表，同步注册
    for (const tool of server.tools) {
      api.registerTool((ctx) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id: string, params: unknown) {
          // 懒连接
          if (!connectionPromises.has(server.name)) {
            connectionPromises.set(
              server.name,
              pool.connect(server)
            );
          }
          await connectionPromises.get(server.name);
          
          return await pool.callTool(server.name, tool.name, params);
        }
      }));
    }
  }
}
```

**优点：**
- ✅ 同步注册，符合 OpenClaw 要求
- ✅ 所有 Agent 都能看到具体工具
- ✅ Agent 知道每个工具的参数 schema
- ✅ 懒连接，不阻塞启动
- ✅ 用户体验好

**缺点：**
- ⚠️ 需要手动维护配置文件中的工具列表
- ⚠️ MCP 服务器更新工具时需要同步更新配置

## 推荐方案

**方案 G（配置文件预定义工具 + 懒连接）**

### 实现步骤

1. **扩展配置 schema**
   ```typescript
   type ServerConfig = {
     name: string;
     command: string;
     args: string[];
     env?: Record<string, string>;
     tools: ToolDefinition[];  // 新增
   };
   
   type ToolDefinition = {
     name: string;
     description?: string;
     inputSchema: object;
   };
   ```

2. **修改插件代码**
   - 从配置文件读取工具列表
   - 同步注册所有工具
   - execute 时懒连接 MCP

3. **提供工具发现脚本**
   ```bash
   # 自动生成配置文件
   node scripts/discover-mcp-tools.js
   ```

### 备选方案

如果不想手动维护配置，可以使用**方案 F（懒加载通用工具）**，但用户体验会差一些。

## 🔥 新发现：OpenClaw 支持热重载！

### 热重载机制

**证据来源**：`moltbot-repo/src/channels/plugins/types.plugin.ts` 第 58 行

```typescript
export type ChannelPlugin = {
  id: ChannelId;
  // ...
  reload?: { 
    configPrefixes: string[];  // 配置变更时触发热重载
    noopPrefixes?: string[];   // 配置变更时不触发任何操作
  };
  // ...
};
```

### 工作原理

1. **配置文件监听**
   - OpenClaw 监听配置文件变化
   - 当配置文件修改时，触发热重载流程

2. **Channel 插件热重载**
   - Channel 插件可以声明 `reload.configPrefixes`
   - 当这些配置路径变更时，重启对应的 Channel
   - 例如：`configPrefixes: ["channels.telegram"]`

3. **重载流程**
   ```
   配置文件变更
     ↓
   检测变更的配置路径
     ↓
   匹配插件的 reload.configPrefixes
     ↓
   执行 restart-channel:${plugin.id}
     ↓
   Channel 重新初始化
   ```

### ✅ 方案 I：利用热重载机制（最佳方案）

**思路：MCP Adapter 声明 reload 配置，配置变更时自动重新加载**

```typescript
// openclaw.plugin.json
{
  "id": "mcp-adapter",
  "kind": "tool",
  "configSchema": {
    "type": "object",
    "properties": {
      "servers": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": { "type": "string" },
            "command": { "type": "string" },
            "args": { "type": "array" },
            "tools": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name": { "type": "string" },
                  "description": { "type": "string" },
                  "inputSchema": { "type": "object" }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

```typescript
// index.ts
export default function (api: any) {
  const config = parseConfig(api.pluginConfig);
  const pool = new McpClientPool();
  const connectionPromises = new Map();

  // 从配置文件读取工具列表，同步注册
  for (const server of config.servers) {
    for (const tool of server.tools) {
      api.registerTool((ctx) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        async execute(_id: string, params: unknown) {
          // 懒连接
          if (!connectionPromises.has(server.name)) {
            connectionPromises.set(
              server.name,
              pool.connect(server)
            );
          }
          await connectionPromises.get(server.name);
          
          return await pool.callTool(server.name, tool.name, params);
        }
      }));
    }
  }

  // 声明热重载配置
  api.registerReload?.({
    configPrefixes: ["plugins.entries.mcp-adapter"],
  });

  // 服务生命周期
  api.registerService({
    id: "mcp-adapter",
    async start() {
      console.log("[mcp-adapter] Service started");
    },
    async stop() {
      await pool.closeAll();
      console.log("[mcp-adapter] Service stopped");
    }
  });
}
```

**工作流程：**

1. **初始加载**
   - 从配置文件读取工具列表
   - 同步注册所有工具
   - 所有 Agent 都能看到工具

2. **MCP 服务器更新工具**
   - 用户运行工具发现脚本：`node scripts/discover-mcp-tools.js`
   - 脚本连接 MCP 服务器，获取最新工具列表
   - 更新配置文件 `openclaw.json`

3. **自动热重载**
   - OpenClaw 检测到配置文件变更
   - 触发 MCP Adapter 重新加载
   - 重新注册工具
   - 新的 Agent 会话看到更新后的工具

**优点：**
- ✅ 同步注册，符合 OpenClaw 要求
- ✅ 所有 Agent 都能看到具体工具
- ✅ 配置变更自动重新加载
- ✅ 提供工具发现脚本，半自动化
- ✅ 用户体验好

**缺点：**
- ⚠️ 需要手动运行工具发现脚本
- ⚠️ 已存在的 Agent 会话不会自动更新（需要重新创建会话）

### 注意事项

**热重载的限制：**
- 只有新创建的 Agent 会话会使用新的工具列表
- 已存在的 Agent 会话仍然使用旧的工具列表
- 如果需要立即生效，需要重启 Gateway

## 结论

OpenClaw **不支持异步插件加载**，但**支持配置热重载**。

**推荐方案 I（配置文件预定义 + 热重载）**：
1. 在配置文件中预定义工具列表
2. 插件加载时同步注册
3. 首次调用时懒连接 MCP
4. 提供工具发现脚本更新配置
5. 配置变更时自动热重载

这是目前最佳的解决方案，兼顾了用户体验和实现复杂度。
