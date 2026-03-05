import { parseConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";
import {
  loadToolsFromCache,
  saveToolsToCache,
  getCacheFilePath,
  getCacheStats,
  type ToolCache,
  type CachedTool,
  type CachedServer,
} from "./cache.js";
import { discoverAllTools, checkAndUpdateTools } from "./discovery.js";

export default function (api: any) {
  const config = parseConfig(api.pluginConfig);

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  const pool = new McpClientPool();
  const cacheFile = getCacheFilePath();

  // 步骤 1: 尝试从缓存加载工具
  const cachedTools = loadToolsFromCache(cacheFile);

  if (cachedTools) {
    const stats = getCacheStats(cachedTools);
    api.logger?.info(
      `[mcp-adapter] Loaded ${stats.totalTools} tools from cache (${stats.totalServers} servers)`
    );

    // 步骤 2: 同步注册缓存的工具（立即可用）
    for (const [serverName, serverData] of Object.entries(cachedTools.servers)) {
      for (const tool of serverData.tools) {
        registerToolFromCache(api, pool, serverName, tool, serverData, config.toolPrefix);
      }
    }

    api.logger?.info(`[mcp-adapter] All cached tools registered successfully`);
  } else {
    api.logger?.info("[mcp-adapter] No cache found, tools will be registered after first connection");
  }

  // Use service lifecycle - connections only happen when gateway starts
  api.registerService({
    id: "mcp-adapter",

    async start() {
      // 步骤 3: 后台异步连接 MCP 服务器，检查更新
      void checkAndUpdateToolsInBackground(api, config.servers, cacheFile, cachedTools, pool);
    },

    async stop() {
      console.log("[mcp-adapter] Shutting down...");
      await pool.closeAll();
      console.log("[mcp-adapter] All connections closed");
    },
  });
}

/**
 * 从缓存注册工具（使用懒连接）
 */
function registerToolFromCache(
  api: any,
  pool: McpClientPool,
  serverName: string,
  tool: CachedTool,
  serverConfig: CachedServer,
  usePrefix: boolean
) {
  const toolName = usePrefix ? `${serverName}_${tool.name}` : tool.name;

  // Use factory function to ensure tools are available to all agents
  api.registerTool(
    (ctx: any) => ({
      name: toolName,
      description: tool.description ?? `Tool from ${serverName}`,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
      async execute(_id: string, params: unknown) {
        // 懒连接：首次调用时才连接 MCP 服务器
        const status = pool.getStatus(serverName);
        if (!status.connected) {
          api.logger?.info(`[mcp-adapter] Lazy connecting to ${serverName}...`);
          await pool.connect({
            name: serverName,
            command: serverConfig.command,
            args: serverConfig.args,
            url: serverConfig.url,
            transport: serverConfig.transport || "stdio",
          });
        }

        const result = await pool.callTool(serverName, tool.name, params);
        const text =
          result.content?.map((c: any) => c.text ?? c.data ?? "").join("\n") ?? "";
        return {
          content: [{ type: "text", text }],
          isError: result.isError,
        };
      },
    }),
    { name: toolName }
  );
}

/**
 * 后台检查并更新工具（仅在首次启动或配置变化时）
 */
async function checkAndUpdateToolsInBackground(
  api: any,
  servers: any[],
  cacheFile: string,
  oldCache: ToolCache | null,
  pool: McpClientPool
) {
  try {
    // 如果没有缓存，说明是首次启动，需要发现工具
    if (!oldCache) {
      api.logger?.info("[mcp-adapter] First startup, discovering tools...");

      const newCache = await discoverAllTools(servers, api.logger);
      saveToolsToCache(newCache, cacheFile);

      const stats = getCacheStats(newCache);
      api.logger?.info(
        `[mcp-adapter] ✅ Discovered ${stats.totalTools} tools from ${stats.totalServers} servers`
      );
      api.logger?.info(
        "[mcp-adapter] ⚠️  Restart OpenClaw Gateway to register these tools"
      );
      return;
    }

    // 检查配置是否有变化（新增或删除服务器）
    const cachedServerNames = new Set(Object.keys(oldCache.servers));
    const configServerNames = new Set(servers.map((s) => s.name));

    const addedServers = servers.filter((s) => !cachedServerNames.has(s.name));
    const removedServers = Array.from(cachedServerNames).filter(
      (name) => !configServerNames.has(name)
    );

    if (addedServers.length > 0 || removedServers.length > 0) {
      api.logger?.info("[mcp-adapter] Configuration changed, updating cache...");

      if (addedServers.length > 0) {
        api.logger?.info(
          `[mcp-adapter] New servers detected: ${addedServers.map((s) => s.name).join(", ")}`
        );
      }

      if (removedServers.length > 0) {
        api.logger?.info(
          `[mcp-adapter] Removed servers: ${removedServers.join(", ")}`
        );
      }

      // 重新发现所有工具
      const newCache = await discoverAllTools(servers, api.logger);
      saveToolsToCache(newCache, cacheFile);

      const stats = getCacheStats(newCache);
      api.logger?.info(
        `[mcp-adapter] Cache updated: ${stats.totalTools} tools from ${stats.totalServers} servers`
      );
      api.logger?.info(
        "[mcp-adapter] ⚠️  Restart OpenClaw Gateway to use the updated tools"
      );
    } else {
      api.logger?.info("[mcp-adapter] Configuration unchanged, using cached tools");
    }

    // 连接所有服务器（保持连接，用于懒加载）
    // 注意：这里不重新注册工具，因为 OpenClaw 不支持动态注册
    for (const server of servers) {
      const status = pool.getStatus(server.name);
      if (!status.connected) {
        try {
          api.logger?.info(`[mcp-adapter] Pre-connecting to ${server.name}...`);
          await pool.connect(server);
        } catch (err) {
          api.logger?.warn(`[mcp-adapter] Failed to pre-connect to ${server.name}: ${err}`);
          // 失败不影响使用，首次调用时会懒连接
        }
      }
    }
  } catch (error) {
    api.logger?.warn(`[mcp-adapter] Failed to check tool updates: ${error}`);
    // 失败不影响使用，继续使用缓存的工具
  }
}
