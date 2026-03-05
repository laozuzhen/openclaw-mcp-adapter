import { McpClientPool } from "./mcp-client.js";
import type { ServerConfig } from "./config.js";
import type { ToolCache, CachedServer } from "./cache.js";
import { calculateChecksum } from "./cache.js";

/**
 * 发现所有配置的 MCP 服务器的工具
 */
export async function discoverAllTools(
  servers: ServerConfig[],
  logger?: { info: (msg: string) => void; warn: (msg: string) => void }
): Promise<ToolCache> {
  const cache: ToolCache = {
    version: "1.0.0",
    lastUpdated: new Date().toISOString(),
    servers: {},
  };

  const pool = new McpClientPool();

  for (const serverConfig of servers) {
    try {
      logger?.info(`[mcp-adapter] Discovering tools from ${serverConfig.name}...`);

      // 连接 MCP 服务器
      await pool.connect(serverConfig);

      // 获取工具列表
      const tools = await pool.listTools(serverConfig.name);

      logger?.info(`[mcp-adapter] ${serverConfig.name}: found ${tools.length} tools`);

      // 保存到缓存
      cache.servers[serverConfig.name] = {
        command: serverConfig.command,
        args: serverConfig.args,
        url: serverConfig.url,
        transport: serverConfig.transport,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
        lastChecked: new Date().toISOString(),
        checksum: calculateChecksum(tools),
      };

      // 断开连接
      await pool.close(serverConfig.name);
    } catch (error) {
      logger?.warn(`[mcp-adapter] Failed to discover tools from ${serverConfig.name}: ${error}`);
      // 继续处理其他服务器
    }
  }

  await pool.closeAll();

  return cache;
}

/**
 * 检查并更新工具缓存
 */
export async function checkAndUpdateTools(
  api: any,
  servers: ServerConfig[],
  cacheFile: string,
  oldCache: ToolCache | null
): Promise<boolean> {
  try {
    api.logger?.info("[mcp-adapter] Checking for tool updates...");

    // 发现所有工具
    const newCache = await discoverAllTools(servers, api.logger);

    // 比较是否有变化
    const hasChanges = compareToolCaches(oldCache, newCache);

    if (hasChanges) {
      api.logger?.info("[mcp-adapter] Tool updates detected");
      return true;
    } else {
      api.logger?.info("[mcp-adapter] Tools are up to date");
      return false;
    }
  } catch (error) {
    api.logger?.warn(`[mcp-adapter] Failed to check tool updates: ${error}`);
    return false;
  }
}

/**
 * 比较两个工具缓存
 */
function compareToolCaches(oldCache: ToolCache | null, newCache: ToolCache): boolean {
  if (!oldCache) {
    return true; // 没有旧缓存，肯定有变化
  }

  // 比较服务器数量
  const oldServers = Object.keys(oldCache.servers);
  const newServers = Object.keys(newCache.servers);

  if (oldServers.length !== newServers.length) {
    return true;
  }

  // 比较每个服务器的工具
  for (const serverName of newServers) {
    const oldServer = oldCache.servers[serverName];
    const newServer = newCache.servers[serverName];

    if (!oldServer) {
      return true; // 新增服务器
    }

    // 比较校验和
    if (oldServer.checksum !== newServer.checksum) {
      return true; // 工具列表有变化
    }
  }

  return false; // 没有变化
}
