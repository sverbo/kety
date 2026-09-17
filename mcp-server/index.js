/**
 * Kety MCP bridge — stdio in, Streamable HTTP out.
 *
 * Claude Desktop launches MCP servers as a subprocess and talks to them over
 * stdio; its config file has no way to point at an HTTP URL. The Kety desktop
 * app serves MCP over Streamable HTTP on 127.0.0.1:47847, so this process
 * bridges the two: it presents a stdio MCP server to the client and forwards
 * every call to the app. Tools are not redefined here — they are read from the
 * app at startup, so there is one source of truth.
 *
 * Claude Code can skip this bridge entirely and connect over HTTP directly.
 *
 * Requires:
 *   - The Kety desktop app to be running.
 *   - KETY_MCP_TOKEN, the access key from Kety → Settings → MCP integration.
 *     Kety refuses every request without it.
 *
 * Claude Desktop — ~/Library/Application Support/Claude/claude_desktop_config.json
 * on macOS (%APPDATA%\Claude\claude_desktop_config.json on Windows):
 *
 *   {
 *     "mcpServers": {
 *       "kety-knowledge": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/mcp-server/index.js"],
 *         "env": { "KETY_MCP_TOKEN": "paste-your-key-here" }
 *       }
 *     }
 *   }
 *
 * Claude Code — no bridge needed, point it at the app directly:
 *
 *   claude mcp add --transport http --scope user kety-knowledge \
 *     http://127.0.0.1:47847/mcp --header "Authorization: Bearer paste-your-key-here"
 *
 * Note that `~/.claude/settings.json` is NOT read for MCP servers — one added
 * there is ignored with no error at all.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MCP_PORT = Number(process.env.KETY_MCP_PORT ?? 47847);
const MCP_URL = new URL(`http://127.0.0.1:${MCP_PORT}/mcp`);
const TOKEN = (process.env.KETY_MCP_TOKEN ?? "").trim();

const NO_TOKEN_MESSAGE =
  "No Kety access key. Open Kety, go to Settings → MCP integration, copy the key, " +
  "and set it as KETY_MCP_TOKEN in this server's configuration.";

const NOT_RUNNING_MESSAGE =
  `Cannot reach Kety on port ${MCP_PORT}. Make sure the desktop app is running.`;

const BAD_TOKEN_MESSAGE =
  "Kety rejected the access key. Copy the current key from Kety → Settings → " +
  "MCP integration and update KETY_MCP_TOKEN.";

/** Turns a transport-level failure into something a person can act on. */
function explain(err) {
  const msg = err instanceof Error ? err.message : String(err);
  // `StreamableHTTPError` carries the HTTP status on `code`; otherwise fall back
  // to the text, because a wrapped fetch failure has no status.
  const status = typeof err?.code === "number" ? err.code : null;
  if (status === 401 || status === 403 || status === 503) {
    return BAD_TOKEN_MESSAGE;
  }
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
    return NOT_RUNNING_MESSAGE;
  }
  return msg;
}

// ── Upstream connection to the desktop app ────────────────────────────────────

let upstream = null;

/**
 * Connects to the app on first use and reuses the connection afterwards. A
 * dropped connection (the app quitting, say) is retried on the next call.
 */
async function getUpstream() {
  if (upstream) return upstream;
  if (!TOKEN) throw new Error(NO_TOKEN_MESSAGE);

  const client = new Client(
    { name: "kety-mcp-bridge", version: "1.0.0" },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  transport.onclose = () => {
    if (upstream === client) upstream = null;
  };
  await client.connect(transport);
  upstream = client;
  return client;
}

// ── stdio server presented to Claude Desktop ──────────────────────────────────

const server = new Server(
  { name: "kety-knowledge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  try {
    const client = await getUpstream();
    return await client.listTools();
  } catch (err) {
    // A client that cannot list tools shows the server as broken with no
    // explanation, so surface an empty list rather than failing the handshake.
    console.error(`[kety-mcp] ${explain(err)}`);
    return { tools: [] };
  }
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const client = await getUpstream();
    return await client.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    });
  } catch (err) {
    upstream = null;
    return { content: [{ type: "text", text: explain(err) }], isError: true };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

if (!TOKEN) {
  console.error(`[kety-mcp] ${NO_TOKEN_MESSAGE}`);
}

await server.connect(new StdioServerTransport());
