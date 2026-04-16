import { describe, expect, it } from "vitest";
import { spawnMockMcpServer } from "../fixtures/mock-mcp.js";

describe("spawnMockMcpServer", () => {
  it("responds to tools/list with the parameterised tool set", async () => {
    const srv = await spawnMockMcpServer({
      tools: [
        { name: "echo", description: "echo", inputSchema: { type: "object" } },
      ],
    });
    const tools = await srv.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    await srv.stop();
  });

  it("echo tool round-trips", async () => {
    const srv = await spawnMockMcpServer({
      tools: [{ name: "echo", description: "", inputSchema: {} }],
    });
    const res = await srv.callTool("echo", { text: "hi" });
    expect(res).toEqual({ content: [{ type: "text", text: "hi" }] });
    await srv.stop();
  });

  it("crash mode exits during initialize", async () => {
    await expect(
      spawnMockMcpServer({ tools: [], crashOn: "initialize" }),
    ).rejects.toThrow();
  });

  it("hang mode never responds to tools/call (timeout expected)", async () => {
    const srv = await spawnMockMcpServer({
      tools: [{ name: "slow", description: "", inputSchema: {} }],
      hangOn: "call",
    });
    await expect(srv.callTool("slow", {}, { timeoutMs: 100 })).rejects.toThrow(
      /timeout/i,
    );
    await srv.stop();
  });
});
