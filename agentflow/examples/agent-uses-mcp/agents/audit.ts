/**
 * audit.ts — Filesystem audit agent definition.
 *
 * Uses the @modelcontextprotocol/server-filesystem MCP server to list files
 * under a given root directory and return a summary with file count.
 *
 * The `runner` parameter is the only thing that changes between cloud, claude,
 * and codex deployments — the rest of the config is identical.
 */

import { defineAgent, safePath } from "@ageflow/core";
import { z } from "zod";

export function auditAgent(runner: "claude" | "codex" | "api") {
  return defineAgent({
    runner,
    input: z.object({ root: z.string() }),
    output: z.object({ summary: z.string(), fileCount: z.number() }),
    prompt: (i) =>
      `List files under ${i.root} via filesystem MCP. Output JSON {summary: string, fileCount: number}.`,
    mcp: {
      servers: [
        {
          name: "filesystem",
          command: "npx",
          args: [
            "-y",
            "@modelcontextprotocol/server-filesystem",
            "/tmp/workdir",
          ],
          tools: ["read_file", "list_directory"],
          refine: {
            read_file: z.object({ path: safePath() }),
            list_directory: z.object({ path: safePath() }),
          },
        },
      ],
    },
  });
}
