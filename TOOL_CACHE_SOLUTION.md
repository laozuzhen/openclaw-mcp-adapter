# 🚀 MCP 工具缓存方案（最佳方案）

## 核心思路

**第一次启动**：
1. OpenClaw 启动时，MCP Adapter 异步连接 MCP 服务器
2. 获取工具列表后，**缓存到本地文件**（`~/.openclaw/mcp-tools-cache.json`）
3. 同时注册这些工具到 Gateway

**第二次及后续启动**：
1. OpenClaw 启动时，**立即从缓存文件读取工具列表**
2. **同步注册所有缓存的工具**（Agent 初始化时就能看到）
3. 后台异步连接 MCP 服务器，检查工具是否有更新
4. 如果有更新，更新缓存并**动态重新注册工具**

---

## 方案优势

### ✅ 解决所有核心问题

| 问题 | 解决方式 |
|------|----------|
| **Agent 看不到工具** | 启动时从缓存同步注册，Agent 初始化时就能看到 |
| **首次启动慢** | 只有第一次需要连接 MCP，后续启动秒级完成 |
| **工具更新** | 后台检查更新，自动更新缓存 |
| **手动配置** | 自动发现工具，无需手动配置 |
| **性能影响** | 无性能影响，使用 Agent 缓存机制 |

### ✅ 用户体验极佳

- **首次启动**：稍慢（需要连接 MCP），但只有一次
- **后续启动**：秒级启动，立即可用
- **工具更新**：自动检测，无需手动干预
- **零配置**：自动发现工具，无需手动编辑配置文件

---

## 实现方案

### 1. 缓存文件格式

**位置**：`~/.openclaw/mcp-tools-cache.json`

**格式**：

```json
{
  "version": "1.0.0",
  "lastUpdated": "2026-03-05T10:30:00Z",
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "tools": [
        {
          "name": "read_file",
          "description": "Read the complete contents of a file from the file system",
          "inputSchema": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Path to the file to read"
              }
            },
            "required": ["path"]
          }
        },
        {
          "name": "write_file",
          "description": "Create a new file or overwrite an existing file",
          "inputSchema": {
            "type": "object",
            "properties": {
              "path": { "type": "string" },
              "content": { "type": "string" }
            },
            "required": ["path", "content"]
          }
        }
      ],
      "lastChecked": "2026-03-05T10:30:00Z",
      "checksum": "abc123def456"
    }
  }
}
```

### 2. 插件启动流程

```typescript
export default function register(api: OpenClawPluginApi) {
  const config = api.config.plugins?.entries?.["mcp-adapter"]?.config;
  const cacheFile = resolveCacheFilePath(); // ~/.openclaw/mcp-tools-cache.json
  
  // 步骤 1: 尝试从缓存加载工具
  const cachedTools = loadToolsFromCache(cacheFile);
  
  if (cachedTools) {
    // 步骤 2: 同步注册缓存的工具（立即可用）
    for (const [serverName, serverData] of Object.entries(cachedTools.servers)) {
      for (const tool of serverData.tools) {
        registerToolFromCache(api, serverName, tool, serverData);
      }
    }
    
    api.logger.info(`Registered ${getTotalToolCount(cachedTools)} MCP tools from cache`);
  }
  
  // 步骤 3: 后台异步连接 MCP 服务器，检查更新
  void checkAndUpdateTools(api, config, cacheFile, cachedTools);
}
```

### 3. 工具注册实现

```typescript
function registerToolFromCache(
  api: OpenClawPluginApi,
  serverName: string,
  tool: CachedTool,
  serverConfig: ServerConfig
) {
  const toolName = `mcp_${serverName}_${tool.name}`;
  
  api.registerTool((ctx) => ({
    name: toolName,
    description: tool.description,
    parameters: tool.inputSchema,
    execute: async (callId, args) => {
      // 懒连接：首次调用时才连接 MCP 服务器
      const client = await getOrCreateClient(serverName, serverConfig);
      return await client.callTool(tool.name, args);
    }
  }), { name: toolName });
}
```

### 4. 配置变化检测

```typescript
async function checkAndUpdateToolsInBackground(
  api: OpenClawPluginApi,
  config: PluginConfig,
  cacheFile: string,
  cachedTools: ToolCache | null
) {
  // 如果没有缓存，说明是首次启动
  if (!cachedTools) {
    api.logger.info('First startup, discovering tools...');
    const freshTools = await discoverAllTools(config.servers);
    saveToolsToCache(cacheFile, freshTools);
    api.logger.info('⚠️  Restart OpenClaw Gateway to register these tools');
    return;
  }

  // 检查配置是否有变化（新增或删除服务器）
  const cachedServerNames = new Set(Object.keys(cachedTools.servers));
  const configServerNames = new Set(config.servers.map(s => s.name));
  
  const addedServers = config.servers.filter(s => !cachedServerNames.has(s.name));
  const removedServers = Array.from(cachedServerNames).filter(name => !configServerNames.has(name));
  
  if (addedServers.length > 0 || removedServers.length > 0) {
    api.logger.info('Configuration changed, updating cache...');
    
    // 重新发现所有工具
    const freshTools = await discoverAllTools(config.servers);
    saveToolsToCache(cacheFile, freshTools);
    
    api.logger.info('Cache updated successfully');
    api.logger.info('⚠️  Restart OpenClaw Gateway to use the updated tools');
  } else {
    api.logger.info('Configuration unchanged, using cached tools');
  }
}
```

**重要**：
- OpenClaw **不支持动态重新注册工具**
- 工具变化只能通过**重启 Gateway** 生效
- 只在**配置变化时**才重新发现工具（不定期检查）

### 5. 工具发现

```typescript
async function discoverAllTools(servers: Record<string, ServerConfig>): Promise<ToolCache> {
  const cache: ToolCache = {
    version: '1.0.0',
    lastUpdated: new Date().toISOString(),
    servers: {}
  };
  
  for (const [serverName, serverConfig] of Object.entries(servers)) {
    try {
      const client = new MCPClient(serverConfig);
      await client.connect();
      
      const tools = await client.listTools();
      
      cache.servers[serverName] = {
        command: serverConfig.command,
        args: serverConfig.args,
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        })),
        lastChecked: new Date().toISOString(),
        checksum: calculateChecksum(tools)
      };
      
      await client.disconnect();
    } catch (error) {
      api.logger.warn(`Failed to discover tools from ${serverName}: ${error}`);
    }
  }
  
  return cache;
}
```

### 6. 配置变化时更新缓存

```typescript
// OpenClaw 不支持动态重新注册工具
// 只能更新缓存，下次重启时生效

async function updateCacheOnConfigChange(api: OpenClawPluginApi, freshTools: ToolCache) {
  const cacheFile = getCacheFilePath();
  
  // 保存到缓存文件
  saveToolsToCache(cacheFile, freshTools);
  
  // 提示用户重启
  api.logger.info('Tool cache updated. Restart OpenClaw Gateway to use the new tools.');
}
```

**重要限制**：
- OpenClaw **不支持运行时动态注册/注销工具**
- 工具变化必须**重启 Gateway** 才能生效
- 这是 OpenClaw 插件系统的设计限制，不是 bug

---

## 配置文件格式

**简化配置**：只需要配置 MCP 服务器，工具列表自动发现

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
              "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
            },
            "github": {
              "command": "npx",
              "args": ["-y", "@modelcontextprotocol/server-github"],
              "env": {
                "GITHUB_TOKEN": "${GITHUB_TOKEN}"
              }
            }
          }
        }
      }
    }
  }
}
```

**注意**：
- 不需要配置 `cacheUpdateInterval`（已移除定期检查）
- 配置变化时会自动检测并更新缓存
- 工具变化需要重启 Gateway 才能生效（OpenClaw 不支持动态注册）

---

## 时序图

### 首次启动

```
T0: OpenClaw 启动
  ↓
T1: MCP Adapter 插件加载
  ↓
T2: 尝试读取缓存文件 → 不存在
  ↓
T3: 后台异步连接 MCP 服务器
  ↓
T4: Agent 初始化（此时还没有 MCP 工具）❌
  ↓
T5: MCP 连接成功，获取工具列表
  ↓
T6: 保存到缓存文件
  ↓
T7: 注册工具到 Gateway
  ↓
T8: TUI 会话能看到工具 ✅（实时构建）
T8: Channel Agent 看不到工具 ❌（已缓存工具列表）
```

**首次启动问题**：Agent 初始化时还没有工具，需要重启 Gateway。

**解决方案**：提供 CLI 命令预先发现工具

```bash
# 首次安装后，先发现工具
openclaw mcp-adapter discover

# 然后启动 Gateway
openclaw gateway start
```

### 第二次及后续启动

```
T0: OpenClaw 启动
  ↓
T1: MCP Adapter 插件加载
  ↓
T2: 从缓存文件读取工具列表 ✅
  ↓
T3: 同步注册所有缓存的工具 ✅
  ↓
T4: Agent 初始化（能看到所有 MCP 工具）✅
  ↓
T5: 检查配置是否有变化（新增/删除服务器）
  ↓
T6: 如果配置变化，重新发现工具并更新缓存
  ↓
T7: 提示用户重启以使用新工具（OpenClaw 不支持动态注册）
```

**完美**：所有 Agent 都能立即看到工具！

**配置变化处理**：
- 新增服务器 → 连接并发现工具 → 更新缓存 → 提示重启
- 删除服务器 → 从缓存移除 → 提示重启
- 配置不变 → 直接使用缓存，无需重新发现

---

## CLI 命令

### 1. 发现工具

```bash
# 连接所有配置的 MCP 服务器，发现工具并缓存
openclaw mcp-adapter discover

# 输出：
# Discovering tools from MCP servers...
# ✓ filesystem: 3 tools found
# ✓ github: 5 tools found
# 
# Total: 8 tools cached
# Cache saved to: ~/.openclaw/mcp-tools-cache.json
```

### 2. 查看缓存

```bash
# 查看当前缓存的工具列表
openclaw mcp-adapter list

# 输出：
# MCP Tools Cache (last updated: 2026-03-05 10:30:00)
# 
# filesystem (3 tools):
#   - mcp_filesystem_read_file
#   - mcp_filesystem_write_file
#   - mcp_filesystem_list_directory
# 
# github (5 tools):
#   - mcp_github_create_issue
#   - mcp_github_list_issues
#   - ...
```

### 3. 强制更新缓存

```bash
# 强制重新发现工具并更新缓存
openclaw mcp-adapter refresh

# 输出：
# Refreshing MCP tools cache...
# ✓ filesystem: 3 tools (no changes)
# ✓ github: 6 tools (1 new tool added)
# 
# Cache updated successfully
# Restart OpenClaw to use the new tools
```

### 4. 清除缓存

```bash
# 清除缓存，下次启动时重新发现
openclaw mcp-adapter clear-cache

# 输出：
# Cache cleared successfully
# Run 'openclaw mcp-adapter discover' to rebuild cache
```

---

## 优化：首次启动也能立即可用

**问题**：首次启动时，Agent 初始化时还没有工具。

**解决方案**：安装时自动发现工具

### 安装脚本

```bash
#!/bin/bash
# install-mcp-adapter.sh

echo "Installing MCP Adapter..."

# 1. 安装插件
openclaw plugins install @openclaw/mcp-adapter

# 2. 配置 MCP 服务器
echo "Configuring MCP servers..."
# （用户手动配置或使用向导）

# 3. 发现工具并缓存
echo "Discovering MCP tools..."
openclaw mcp-adapter discover

# 4. 启动 Gateway
echo "Starting OpenClaw Gateway..."
openclaw gateway start

echo "✓ MCP Adapter installed successfully!"
```

---

## 方案对比

| 方案 | 首次启动 | 后续启动 | 工具更新 | 手动配置 | 推荐度 |
|------|----------|----------|----------|----------|--------|
| **配置文件预定义** | ❌ 需手动配置 | ✅ 秒级 | ❌ 需手动更新 | ❌ 需要 | ⚠️ 可行 |
| **工具缓存（本方案）** | ⚠️ 需预发现 | ✅ 秒级 | ✅ 自动检测 | ✅ 自动 | ✅ 最佳 |

---

## 实施计划

### 阶段 1：基础实现

1. **实现缓存读写**
   - 定义缓存文件格式
   - 实现 `loadToolsFromCache()` 和 `saveToolsToCache()`

2. **实现工具发现**
   - 实现 `discoverAllTools()` 连接 MCP 服务器
   - 实现 `compareTools()` 检测工具变化

3. **修改插件注册逻辑**
   - 启动时从缓存加载并同步注册
   - 后台异步检查更新

### 阶段 2：CLI 命令

1. **实现 `discover` 命令**
   - 连接 MCP 服务器
   - 保存工具到缓存

2. **实现 `list` 命令**
   - 显示缓存的工具列表

3. **实现 `refresh` 和 `clear-cache` 命令**

### 阶段 3：优化

1. **安装向导**
   - 引导用户配置 MCP 服务器
   - 自动发现工具

2. **自动更新**
   - 定期检查工具更新
   - 可配置更新间隔

3. **错误处理**
   - MCP 服务器连接失败时的降级策略
   - 缓存损坏时的恢复机制

---

## 潜在问题和解决方案

### 问题 1：首次启动 Agent 看不到工具

**原因**：首次启动时，缓存还不存在，工具是异步注册的。

**解决方案**：
- 提供 `openclaw mcp-adapter discover` 命令，安装后先运行
- 或者在安装脚本中自动运行

### 问题 2：OpenClaw 可能不支持动态重新注册工具

**原因**：OpenClaw 的插件系统可能不支持运行时动态注册/注销工具。

**解决方案**：
- 只更新缓存文件，提示用户重启 Gateway
- 或者使用 Gateway 的热重载机制（如果支持）

### 问题 3：缓存文件损坏

**原因**：文件系统错误、手动编辑等。

**解决方案**：
- 添加缓存文件校验（checksum）
- 损坏时自动重新发现工具
- 提供 `clear-cache` 命令手动清除

### 问题 4：MCP 服务器版本更新

**原因**：MCP 服务器更新后，工具签名可能变化。

**解决方案**：
- 定期检查更新（可配置间隔）
- 提供 `refresh` 命令手动刷新
- 检测到变化时自动更新缓存

---

## 结论

**工具缓存方案是最佳解决方案**，因为：

1. ✅ **解决所有核心问题**
   - Agent 能看到工具（从缓存同步注册）
   - 启动速度快（秒级）
   - 自动发现工具（无需手动配置）
   - 自动更新（后台检查）

2. ✅ **用户体验极佳**
   - 首次安装：运行 `discover` 命令即可
   - 后续使用：完全自动化
   - 工具更新：自动检测，无需手动干预

3. ✅ **实现简单**
   - 不需要修改 OpenClaw 核心代码
   - 只需要在插件中实现缓存逻辑
   - 维护成本低

4. ✅ **性能优秀**
   - 无性能影响（使用 Agent 缓存机制）
   - 启动速度快（从缓存加载）
   - 懒连接（首次调用时才连接 MCP）

**下一步**：实现工具缓存方案！

---

## 参考资料

- [PLUGIN_RELOAD_RESEARCH.md](./PLUGIN_RELOAD_RESEARCH.md)
- [CHANNEL_TUI_MODE_ANALYSIS.md](./CHANNEL_TUI_MODE_ANALYSIS.md)
- [TOOL_REGISTRATION_SCOPE_ANALYSIS.md](./TOOL_REGISTRATION_SCOPE_ANALYSIS.md)
