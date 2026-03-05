# MCP Adapter (OpenClaw Plugin)

> **🔧 Fixed Fork**: This is a fixed version of [androidStern-personal/openclaw-mcp-adapter](https://github.com/androidStern-personal/openclaw-mcp-adapter) that resolves the multi-agent tool registration issue.

Exposes MCP (Model Context Protocol) server tools as native OpenClaw agent tools.

Instead of running MCP servers through a CLI skill, this plugin connects to your MCP servers at startup, discovers their tools, and registers each one as a first-class tool that agents can invoke directly.

## 🆕 What's Fixed

**Original Issue**: MCP tools were only available to the `main` agent, not to other agents.

**Root Cause**: The plugin registered tools as static objects instead of factory functions, preventing proper per-agent tool instantiation.

**Fix**: Changed tool registration to use factory functions that are called for each agent:

```typescript
// ❌ Before: Static object (only works for main agent)
api.registerTool({
  name: toolName,
  description: "...",
  parameters: {...},
  async execute(id, params) {...}
})

// ✅ After: Factory function (works for all agents)
api.registerTool(
  (ctx) => ({
    name: toolName,
    description: "...",
    parameters: {...},
    async execute(id, params) {...}
  }),
  { name: toolName }
)
```

Now MCP tools are properly available to all agents in your OpenClaw setup.

## Requirements

- OpenClaw gateway
- Node.js 18+
- MCP servers you want to connect to

## Installation

```bash
# Install from this fixed fork
openclaw plugins install https://github.com/laozuzhen/openclaw-mcp-adapter.git
```

**Alternative: install from source**

```bash
git clone https://github.com/laozuzhen/openclaw-mcp-adapter.git
openclaw plugins install ./openclaw-mcp-adapter
```

## Configuration

### 1. Enable the plugin and configure servers

Add to `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "mcp-adapter": {
        "enabled": true,
        "config": {
          "servers": [
            {
              "name": "myserver",
              "transport": "stdio",
              "command": "npx",
              "args": ["-y", "some-mcp-server"],
              "env": {
                "API_KEY": "${MY_API_KEY}"
              }
            }
          ]
        }
      }
    }
  }
}
```

### 2. Allow for sandboxed agents

Add `"mcp-adapter"` to your sandbox tool allowlist:

```json
{
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["group:runtime", "group:fs", "mcp-adapter"]
      }
    }
  }
}
```

### 3. Restart the gateway

```bash
openclaw gateway restart
```

### 4. Verify

```bash
openclaw plugins list
# Should show: MCP Adapter | mcp-adapter | loaded
```

## Server Configuration

### Stdio transport (spawns a subprocess)

```json
{
  "name": "filesystem",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@anthropic/mcp-filesystem", "/path/to/dir"],
  "env": {
    "SOME_VAR": "value"
  }
}
```

### HTTP transport (connects to a running server)

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

## Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `servers` | array | `[]` | List of MCP servers to connect to |
| `toolPrefix` | boolean | `true` | Prefix tool names with server name (e.g., `myserver_toolname`) |

### Server Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `name` | string | Yes | Unique name for this server |
| `transport` | `"stdio"` \| `"http"` | No | Connection type (default: `stdio`) |
| `command` | string | stdio only | Command to spawn |
| `args` | string[] | No | Command arguments |
| `env` | object | No | Environment variables |
| `url` | string | http only | Server URL |
| `headers` | object | No | HTTP request headers |

## Environment Variable Interpolation

Use `${VAR_NAME}` in `env` and `headers` values to reference environment variables from `~/.openclaw/.env`:

```json
{
  "env": {
    "API_KEY": "${MY_SERVICE_API_KEY}"
  }
}
```

## How It Works

1. On gateway startup, the plugin connects to each configured MCP server
2. Calls `listTools()` to discover available tools
3. Registers each tool with OpenClaw using its name, description, and JSON Schema
4. When an agent invokes a tool, the plugin proxies the call to the MCP server
5. If the connection dies, it automatically reconnects on the next tool call

## Example: AgentMail

```json
{
  "name": "agentmail",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "agentmail-mcp"],
  "env": {
    "AGENTMAIL_API_KEY": "${AGENTMAIL_API_KEY}"
  }
}
```

This registers tools like `agentmail_create_inbox`, `agentmail_send_email`, etc.

## License

MIT
