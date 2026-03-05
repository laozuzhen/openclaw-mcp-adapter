# OpenClaw MCP Adapter 项目分析

## 📋 项目概述

**项目名称**: openclaw-mcp-adapter  
**作者**: androidStern-personal  
**版本**: 0.1.1  
**许可证**: MIT  
**仓库**: https://github.com/androidStern-personal/openclaw-mcp-adapter

**一句话描述**: 将 MCP (Model Context Protocol) 服务器的工具暴露为 OpenClaw 原生代理工具的适配器插件。

---

## 🎯 核心功能

### 主要特性

1. **MCP 服务器连接**
   - 支持 stdio 传输（启动子进程）
   - 支持 HTTP 传输（连接到运行中的服务器）
   - 自动重连机制

2. **工具发现与注册**
   - 启动时自动调用 `listTools()` 发现 MCP 工具
   - 将每个 MCP 工具注册为 OpenClaw 原生工具
   - 支持工具名称前缀（避免冲突）

3. **工具调用代理**
   - 代理 OpenClaw 工具调用到 MCP 服务器
   - 自动处理连接断开和重连
   - 统一的错误处理

4. **环境变量插值**
   - 支持 `${VAR_NAME}` 语法引用环境变量
   - 适用于 `env` 和 `headers` 配置

---

## 🏗️ 架构设计

### 核心模块

| 文件 | 功能 |
|------|------|
| `index.ts` | 插件入口，注册服务和工具 |
| `mcp-client.ts` | MCP 客户端连接池管理 |
| `config.ts` | 配置解析和环境变量插值 |
| `openclaw.plugin.json` | 插件元数据和配置 schema |

### 关键类

#### `McpClientPool`
- **职责**: 管理多个 MCP 服务器连接
- **核心方法**:
  - `connect(config)` - 连接到 MCP 服务器
  - `listTools(serverName)` - 列出服务器工具
  - `callTool(serverName, toolName, args)` - 调用工具（带自动重连）
  - `reconnect(serverName)` - 重新连接断开的服务器
  - `closeAll()` - 关闭所有连接

---

## 🔧 技术实现

### 1. 服务生命周期

```typescript
api.registerService({
  id: "mcp-adapter",
  
  async start() {
    // 连接所有配置的 MCP 服务器
    // 发现并注册工具
  },
  
  async stop() {
    // 关闭所有连接
  }
});
```

### 2. 工具注册流程

```
启动 Gateway
  ↓
连接 MCP 服务器
  ↓
调用 listTools()
  ↓
遍历每个工具
  ↓
注册为 OpenClaw 工具
  ↓
代理工具调用
```

### 3. 自动重连机制

```typescript
async callTool(serverName, toolName, args) {
  try {
    return await client.callTool(...);
  } catch (err) {
    if (isConnectionError(err)) {
      await reconnect(serverName);
      return await client.callTool(...); // 重试
    }
    throw err;
  }
}
```

### 4. 传输类型

**Stdio 传输**:
```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@anthropic/mcp-filesystem", "/path/to/dir"],
  "env": {
    "API_KEY": "${MY_API_KEY}"
  }
}
```

**HTTP 传输**:
```json
{
  "name": "api",
  "transport": "http",
  "url": "http://localhost:3000/mcp",
  "headers": {
    "Authorization": "Bearer ${API_TOKEN}"
  }
}
```

---

## 📦 依赖项

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | ^1.0.0 | MCP 协议客户端 SDK |

---

## 🔌 与 xianyu-super-butler 的集成潜力

### 可复用的设计模式

1. **插件架构**
   - ✅ 使用 `openclaw.plugin.json` 定义插件元数据
   - ✅ 使用 `api.registerService()` 注册服务生命周期
   - ✅ 使用 `api.registerTool()` 注册工具

2. **连接池管理**
   - ✅ 管理多个外部服务连接
   - ✅ 自动重连机制
   - ✅ 优雅关闭

3. **配置管理**
   - ✅ JSON Schema 验证
   - ✅ 环境变量插值
   - ✅ 多服务器配置

### 对比 xianyu-super-butler 的实现

| 特性 | MCP Adapter | xianyu-super-butler |
|------|-------------|---------------------|
| **连接管理** | McpClientPool | BridgeClient + ConnectionManager |
| **工具注册** | 动态发现 + 注册 | 手动定义工具 schema |
| **重连机制** | 自动重连 | 手动重连 + 心跳检测 |
| **配置方式** | JSON Schema | YAML + TypeScript |
| **传输协议** | stdio + HTTP | HTTP (Bridge API) |

### 可借鉴的优化点

#### 1. 动态工具发现
**当前 xianyu-super-butler**:
```typescript
// 手动定义每个工具
api.registerTool({
  name: "xianyu_publish_product",
  description: "发布单个商品到闲鱼",
  parameters: { /* 手动定义 schema */ }
});
```

**MCP Adapter 方式**:
```typescript
// 自动发现工具
const tools = await pool.listTools(serverName);
for (const tool of tools) {
  api.registerTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema // 自动获取
  });
}
```

**建议**: 为 Bridge API 添加 `/api/tools/list` 端点，返回所有可用工具的 schema。

#### 2. 连接池模式
**当前 xianyu-super-butler**:
```typescript
// 单一连接管理
class BridgeClient {
  private ws: WebSocket | null = null;
  // ...
}
```

**MCP Adapter 方式**:
```typescript
// 连接池管理多个服务
class McpClientPool {
  private clients = new Map<string, ClientEntry>();
  // 支持多个独立的 MCP 服务器
}
```

**建议**: 如果未来需要连接多个 Bridge 实例（如多账号），可以参考连接池模式。

#### 3. 自动重连逻辑
**当前 xianyu-super-butler**:
```typescript
// 手动触发重连
private async reconnect() {
  if (this.reconnecting) return;
  this.reconnecting = true;
  // ...
}
```

**MCP Adapter 方式**:
```typescript
// 调用时自动重连
async callTool(serverName, toolName, args) {
  try {
    return await client.callTool(...);
  } catch (err) {
    if (isConnectionError(err)) {
      await reconnect(serverName);
      return await client.callTool(...); // 透明重试
    }
  }
}
```

**建议**: 在工具调用失败时自动重连，而不是依赖心跳检测。

---

## 💡 集成建议

### 方案 A: 直接复用 MCP Adapter 架构（推荐）

**优点**:
- 成熟的连接管理
- 自动工具发现
- 标准化的 MCP 协议

**实施步骤**:
1. 将 Bridge API 改造为 MCP 服务器
2. 实现 MCP 协议的 `listTools()` 和 `callTool()` 端点
3. 复用 `McpClientPool` 的连接管理逻辑
4. 复用 `config.ts` 的配置解析逻辑

### 方案 B: 借鉴设计模式，保持现有架构

**优点**:
- 不需要大规模重构
- 保持现有的 Bridge API 设计

**实施步骤**:
1. 参考 `McpClientPool` 优化 `ConnectionManager`
2. 添加自动工具发现机制
3. 改进重连逻辑（调用时重连 vs 心跳重连）
4. 统一配置管理（参考 `config.ts`）

---

## 🎯 关键代码片段

### 1. 服务注册（可直接复用）

```typescript
api.registerService({
  id: "xianyu-butler",
  
  async start() {
    console.log("[xianyu-butler] Starting...");
    await bridgeClient.connect();
    await registerTools();
  },
  
  async stop() {
    console.log("[xianyu-butler] Stopping...");
    await bridgeClient.disconnect();
  }
});
```

### 2. 环境变量插值（可直接复用）

```typescript
function interpolateEnv(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = v.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  }
  return result;
}
```

### 3. 连接错误检测（可直接复用）

```typescript
private isConnectionError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("closed") || 
         msg.includes("ECONNREFUSED") || 
         msg.includes("EPIPE");
}
```

---

## 📊 性能考虑

### 连接管理
- ✅ 连接池复用，避免频繁创建连接
- ✅ 懒加载重连，只在需要时重连
- ✅ 优雅关闭，避免资源泄漏

### 工具调用
- ✅ 直接代理，无额外序列化开销
- ✅ 错误时才重连，正常情况无额外延迟

---

## 🚀 总结

### 核心价值

1. **标准化**: 使用 MCP 协议标准化工具接口
2. **自动化**: 自动发现和注册工具，减少手动配置
3. **可靠性**: 自动重连机制，提高系统稳定性
4. **可扩展**: 连接池模式支持多服务器

### 对 xianyu-super-butler 的启示

1. **工具发现**: 考虑添加 `/api/tools/list` 端点
2. **连接管理**: 参考连接池模式优化 `ConnectionManager`
3. **重连策略**: 从心跳检测改为调用时重连
4. **配置管理**: 统一使用 JSON Schema 验证

### 推荐行动

- ✅ 复用 `McpClientPool` 的连接管理逻辑
- ✅ 复用 `config.ts` 的环境变量插值
- ✅ 参考服务生命周期管理模式
- ✅ 考虑将 Bridge API 改造为 MCP 兼容

---

**分析完成时间**: 2026-03-05  
**分析人**: Kiro AI  
**项目质量评分**: 9/10 ⭐

**评分理由**:
- ✅ 代码简洁清晰（约 200 行核心代码）
- ✅ 架构设计合理（连接池 + 服务生命周期）
- ✅ 错误处理完善（自动重连 + 错误检测）
- ✅ 配置灵活（支持多种传输方式）
- ⚠️ 缺少单元测试
- ⚠️ 文档可以更详细（如错误处理流程）
