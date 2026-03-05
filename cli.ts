#!/usr/bin/env node

import {
  loadToolsFromCache,
  saveToolsToCache,
  clearCache,
  getCacheFilePath,
  getCacheStats,
} from "./cache.js";
import { discoverAllTools } from "./discovery.js";
import type { ServerConfig } from "./config.js";

/**
 * CLI 命令处理
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case "discover":
      await discoverCommand();
      break;

    case "list":
      await listCommand();
      break;

    case "refresh":
      await refreshCommand();
      break;

    case "clear-cache":
      await clearCacheCommand();
      break;

    case "help":
    case "--help":
    case "-h":
      printHelp();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

/**
 * discover 命令：发现所有 MCP 工具并缓存
 */
async function discoverCommand() {
  console.log("🔍 Discovering tools from MCP servers...\n");

  try {
    // 读取配置文件（需要从 OpenClaw 配置中读取）
    const servers = await loadServersFromConfig();

    if (servers.length === 0) {
      console.error("❌ No MCP servers configured");
      console.log("\nPlease configure MCP servers in your OpenClaw config file:");
      console.log("  ~/.openclaw/config.json");
      process.exit(1);
    }

    // 发现工具
    const cache = await discoverAllTools(servers, {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    });

    // 保存到缓存
    const cacheFile = getCacheFilePath();
    saveToolsToCache(cache, cacheFile);

    // 显示统计信息
    const stats = getCacheStats(cache);
    console.log("\n✅ Discovery completed!\n");
    console.log(`Total servers: ${stats.totalServers}`);
    console.log(`Total tools: ${stats.totalTools}`);
    console.log(`\nCache saved to: ${cacheFile}`);

    console.log("\nServers:");
    for (const server of stats.servers) {
      console.log(`  ✓ ${server.name}: ${server.toolCount} tools`);
    }

    console.log("\n💡 Restart OpenClaw Gateway to use these tools");
  } catch (error) {
    console.error(`\n❌ Discovery failed: ${error}`);
    process.exit(1);
  }
}

/**
 * list 命令：显示缓存的工具列表
 */
async function listCommand() {
  const cacheFile = getCacheFilePath();
  const cache = loadToolsFromCache(cacheFile);

  if (!cache) {
    console.log("❌ No cache found");
    console.log("\nRun 'openclaw mcp-adapter discover' to discover tools");
    process.exit(1);
  }

  const stats = getCacheStats(cache);

  console.log(`📦 MCP Tools Cache (last updated: ${new Date(cache.lastUpdated).toLocaleString()})\n`);
  console.log(`Total servers: ${stats.totalServers}`);
  console.log(`Total tools: ${stats.totalTools}\n`);

  for (const [serverName, serverData] of Object.entries(cache.servers)) {
    console.log(`\n${serverName} (${serverData.tools.length} tools):`);
    for (const tool of serverData.tools) {
      console.log(`  - ${tool.name}`);
      if (tool.description) {
        console.log(`    ${tool.description}`);
      }
    }
  }

  console.log(`\nCache file: ${cacheFile}`);
}

/**
 * refresh 命令：强制刷新缓存
 */
async function refreshCommand() {
  console.log("🔄 Refreshing MCP tools cache...\n");

  try {
    // 读取配置文件
    const servers = await loadServersFromConfig();

    if (servers.length === 0) {
      console.error("❌ No MCP servers configured");
      process.exit(1);
    }

    // 读取旧缓存
    const cacheFile = getCacheFilePath();
    const oldCache = loadToolsFromCache(cacheFile);

    // 发现工具
    const newCache = await discoverAllTools(servers, {
      info: (msg) => console.log(msg),
      warn: (msg) => console.warn(msg),
    });

    // 保存到缓存
    saveToolsToCache(newCache, cacheFile);

    // 比较变化
    const oldStats = oldCache ? getCacheStats(oldCache) : null;
    const newStats = getCacheStats(newCache);

    console.log("\n✅ Cache refreshed!\n");

    if (oldStats) {
      const toolDiff = newStats.totalTools - oldStats.totalTools;
      if (toolDiff > 0) {
        console.log(`📈 ${toolDiff} new tool(s) added`);
      } else if (toolDiff < 0) {
        console.log(`📉 ${Math.abs(toolDiff)} tool(s) removed`);
      } else {
        console.log("✓ No changes detected");
      }
    }

    console.log(`\nTotal tools: ${newStats.totalTools}`);
    console.log(`Cache file: ${cacheFile}`);

    console.log("\n💡 Restart OpenClaw Gateway to use the updated tools");
  } catch (error) {
    console.error(`\n❌ Refresh failed: ${error}`);
    process.exit(1);
  }
}

/**
 * clear-cache 命令：清除缓存
 */
async function clearCacheCommand() {
  const cacheFile = getCacheFilePath();

  console.log(`🗑️  Clearing cache: ${cacheFile}`);

  try {
    clearCache(cacheFile);
    console.log("\n✅ Cache cleared successfully");
    console.log("\n💡 Run 'openclaw mcp-adapter discover' to rebuild cache");
  } catch (error) {
    console.error(`\n❌ Failed to clear cache: ${error}`);
    process.exit(1);
  }
}

/**
 * 打印帮助信息
 */
function printHelp() {
  console.log(`
MCP Adapter CLI

Usage:
  openclaw mcp-adapter <command>

Commands:
  discover      Discover tools from all configured MCP servers and cache them
  list          List all cached tools
  refresh       Force refresh the tool cache
  clear-cache   Clear the tool cache
  help          Show this help message

Examples:
  # First time setup: discover tools
  openclaw mcp-adapter discover

  # View cached tools
  openclaw mcp-adapter list

  # Update cache after MCP server changes
  openclaw mcp-adapter refresh

  # Clear cache and start fresh
  openclaw mcp-adapter clear-cache
`);
}

/**
 * 从 OpenClaw 配置文件加载服务器配置
 */
async function loadServersFromConfig(): Promise<ServerConfig[]> {
  // TODO: 实现从 OpenClaw 配置文件读取
  // 这里需要读取 ~/.openclaw/config.json 或类似的配置文件
  // 暂时返回空数组，实际使用时需要实现

  console.warn("⚠️  Warning: Config loading not implemented yet");
  console.log("Please configure servers manually in the plugin config");

  return [];
}

// 运行 CLI
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
