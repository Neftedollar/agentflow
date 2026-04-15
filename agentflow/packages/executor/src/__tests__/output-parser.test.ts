import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseAgentOutput } from "../output-parser.js";
import { OutputValidationError } from "../errors.js";

const schema = z.object({
  answer: z.string(),
  count: z.number(),
});

describe("parseAgentOutput", () => {
  it("parses plain JSON object correctly", () => {
    const stdout = JSON.stringify({ answer: "hello", count: 42 });
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "hello", count: 42 });
  });

  it("parses JSON wrapped in ```json fence", () => {
    const stdout = "```json\n{\"answer\": \"world\", \"count\": 7}\n```";
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "world", count: 7 });
  });

  it("parses JSON wrapped in ``` fence (no language)", () => {
    const stdout = "```\n{\"answer\": \"bare\", \"count\": 0}\n```";
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "bare", count: 0 });
  });

  it("throws OutputValidationError for invalid JSON", () => {
    const stdout = "this is not json at all";
    expect(() => parseAgentOutput(stdout, schema, "my-task")).toThrow(OutputValidationError);
  });

  it("includes 'Could not parse JSON' in error message for invalid JSON", () => {
    const stdout = "{ broken json }";
    expect(() => parseAgentOutput(stdout, schema, "my-task")).toThrow(/Could not parse JSON/);
  });

  it("throws OutputValidationError when JSON fails Zod schema validation", () => {
    const stdout = JSON.stringify({ answer: 123, count: "not-a-number" });
    expect(() => parseAgentOutput(stdout, schema, "my-task")).toThrow(OutputValidationError);
  });

  it("includes schema error message in OutputValidationError", () => {
    const stdout = JSON.stringify({ wrong_field: "value" });
    let caught: OutputValidationError | undefined;
    try {
      parseAgentOutput(stdout, schema, "my-task");
    } catch (e) {
      if (e instanceof OutputValidationError) {
        caught = e;
      }
    }
    expect(caught).toBeInstanceOf(OutputValidationError);
    expect(caught?.taskName).toBe("my-task");
  });

  it("strips extra fields by Zod (strip mode)", () => {
    const stdout = JSON.stringify({ answer: "hello", count: 1, extra: "unwanted" });
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "hello", count: 1 });
    expect("extra" in result).toBe(false);
  });

  it("handles whitespace around JSON", () => {
    const stdout = "  \n" + JSON.stringify({ answer: "padded", count: 5 }) + "\n  ";
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "padded", count: 5 });
  });

  it("throws OutputValidationError for invalid JSON in fence", () => {
    const stdout = "```json\n{broken}\n```";
    expect(() => parseAgentOutput(stdout, schema, "my-task")).toThrow(OutputValidationError);
  });

  it("sets correct taskName in OutputValidationError", () => {
    const stdout = "not-json";
    let caught: OutputValidationError | undefined;
    try {
      parseAgentOutput(stdout, schema, "specific-task-name");
    } catch (e) {
      if (e instanceof OutputValidationError) {
        caught = e;
      }
    }
    expect(caught?.taskName).toBe("specific-task-name");
  });

  it("works with z.string() schema", () => {
    const stdout = '"hello world"';
    const result = parseAgentOutput(stdout, z.string(), "test-task");
    expect(result).toBe("hello world");
  });

  it("works with z.array schema", () => {
    const stdout = JSON.stringify([1, 2, 3]);
    const result = parseAgentOutput(stdout, z.array(z.number()), "test-task");
    expect(result).toEqual([1, 2, 3]);
  });

  it("extracts JSON from fence block preceded by prose (regression B2)", () => {
    // Regression test: agent output with explanation text before the code fence.
    // Common Claude pattern: "Here's the result:\n\n```json\n{...}\n```"
    const stdout = "Here's the structured result:\n\n```json\n{\"answer\": \"prose\", \"count\": 3}\n```";
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "prose", count: 3 });
  });

  it("extracts JSON from fence block followed by prose", () => {
    const stdout = "```json\n{\"answer\": \"before\", \"count\": 1}\n```\n\nNote: this is the answer.";
    const result = parseAgentOutput(stdout, schema, "test-task");
    expect(result).toEqual({ answer: "before", count: 1 });
  });
});
