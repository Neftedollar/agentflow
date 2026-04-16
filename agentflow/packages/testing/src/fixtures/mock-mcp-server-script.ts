/**
 * mock-mcp-server-script.ts
 *
 * Subprocess entry point for a mock MCP server.
 * Reads config from --config <base64-json> CLI argument.
 * Connects over stdio using @modelcontextprotocol/sdk Server + StdioServerTransport.
 *
 * Config shape (MockMcpServerOpts serialised as base64 JSON, without refine):
 *   { tools, crashOn?, hangOn?, isErrorOn? }
 *
 * Usage:
 *   node mock-mcp-server-script.js --config <base64>
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

interface ToolSpec {
  name: string;
  description?: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON schema is untyped
  inputSchema?: Record<string, any>;
}

interface ScriptConfig {
  tools: ToolSpec[];
  crashOn?: "initialize" | "tools/list" | "call";
  hangOn?: "initialize" | "tools/list" | "call";
  isErrorOn?: string;
}

function parseArgs(): ScriptConfig {
  const idx = process.argv.indexOf("--config");
  const configArg = process.argv[idx + 1];
  if (idx === -1 || !configArg) {
    throw new Error("mock-mcp-server-script: --config argument is required");
  }
  const raw = Buffer.from(configArg, "base64").toString("utf-8");
  return JSON.parse(raw) as ScriptConfig;
}

async function main(): Promise<void> {
  const cfg = parseArgs();

  if (cfg.crashOn === "initialize") {
    process.stderr.write("mock-mcp: crashing on initialize\n");
    process.exit(1);
  }

  const server = new Server(
    { name: "mock-mcp", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (cfg.hangOn === "tools/list") {
      await new Promise(() => {}); // hang forever
    }
    if (cfg.crashOn === "tools/list") {
      process.exit(1);
    }
    return {
      tools: cfg.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: {
          type: "object" as const,
          ...(t.inputSchema ?? {}),
        },
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (cfg.hangOn === "call") {
      await new Promise(() => {}); // hang forever
    }
    if (cfg.crashOn === "call") {
      process.exit(1);
    }
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    if (name === cfg.isErrorOn) {
      return {
        content: [
          { type: "text" as const, text: `error: tool ${name} failed` },
        ],
        isError: true,
      };
    }

    // Default echo behaviour: return args as JSON text
    const textArg = args.text;
    const text = typeof textArg === "string" ? textArg : JSON.stringify(args);
    return {
      content: [{ type: "text" as const, text }],
      isError: false,
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `mock-mcp-server-script error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
