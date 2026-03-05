import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * 缓存的工具信息
 */
export interface CachedTool {
  name: string;
  description?: string;
  inputSchema: any;
}

/**
 * 缓存的服务器信息
 */
export interface CachedServer {
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "http";
  tools: CachedTool[];
  lastChecked: string;
  checksum: string;
}

/**
 * 工具缓存文件格式
 */
export interface ToolCache {
  version: string;
  lastUpdated: string;
  servers: Record<string, CachedServer>;
}

/**
 * 获取缓存文件路径
 */
export function getCacheFilePath(): string {
  const homeDir = os.homedir();
  const openclawDir = path.join(homeDir, ".openclaw");
  
  // 确保目录存在
  if (!fs.existsSync(openclawDir)) {
    fs.mkdirSync(openclawDir, { recursive: true });
  }
  
  return path.join(openclawDir, "mcp-tools-cache.json");
}

/**
 * 从缓存文件加载工具列表
 */
export function loadToolsFromCache(cacheFile?: string): ToolCache | null {
  const filePath = cacheFile || getCacheFilePath();
  
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const content = fs.readFileSync(filePath, "utf-8");
    const cache = JSON.parse(content) as ToolCache;
    
    // 验证缓存格式
    if (!cache.version || !cache.servers) {
      console.warn("[mcp-adapter] Invalid cache format, ignoring");
      return null;
    }
    
    return cache;
  } catch (error) {
    console.error("[mcp-adapter] Failed to load cache:", error);
    return null;
  }
}

/**
 * 保存工具列表到缓存文件
 */
export function saveToolsToCache(cache: ToolCache, cacheFile?: string): void {
  const filePath = cacheFile || getCacheFilePath();
  
  try {
    const content = JSON.stringify(cache, null, 2);
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`[mcp-adapter] Cache saved to: ${filePath}`);
  } catch (error) {
    console.error("[mcp-adapter] Failed to save cache:", error);
    throw error;
  }
}

/**
 * 计算工具列表的校验和
 */
export function calculateChecksum(tools: Tool[]): string {
  const data = JSON.stringify(tools.map(t => ({ name: t.name, inputSchema: t.inputSchema })));
  return crypto.createHash("sha256").update(data).digest("hex").substring(0, 16);
}

/**
 * 比较两个工具缓存是否有差异
 */
export function compareTools(oldCache: ToolCache | null, newCache: ToolCache): boolean {
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

/**
 * 清除缓存文件
 */
export function clearCache(cacheFile?: string): void {
  const filePath = cacheFile || getCacheFilePath();
  
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[mcp-adapter] Cache cleared: ${filePath}`);
    } else {
      console.log("[mcp-adapter] No cache file to clear");
    }
  } catch (error) {
    console.error("[mcp-adapter] Failed to clear cache:", error);
    throw error;
  }
}

/**
 * 获取缓存统计信息
 */
export function getCacheStats(cache: ToolCache): {
  totalServers: number;
  totalTools: number;
  lastUpdated: string;
  servers: Array<{ name: string; toolCount: number }>;
} {
  const servers = Object.entries(cache.servers).map(([name, server]) => ({
    name,
    toolCount: server.tools.length,
  }));
  
  const totalTools = servers.reduce((sum, s) => sum + s.toolCount, 0);
  
  return {
    totalServers: servers.length,
    totalTools,
    lastUpdated: cache.lastUpdated,
    servers,
  };
}
