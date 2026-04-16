import { describe, expect, it } from "vitest";
import { expandEnvVars } from "../mcp-env.js";

describe("expandEnvVars", () => {
  it("leaves literal values alone", () => {
    expect(expandEnvVars("hello", {})).toBe("hello");
  });
  it("resolves ${env:NAME} from the provided env map", () => {
    expect(expandEnvVars("${env:FOO}", { FOO: "bar" })).toBe("bar");
  });
  it("throws MissingEnvVarError when env var is unset", () => {
    expect(() => expandEnvVars("${env:MISSING}", {})).toThrow(/MISSING/);
  });
  it("supports multiple substitutions in one string", () => {
    expect(expandEnvVars("${env:A}-${env:B}", { A: "x", B: "y" })).toBe("x-y");
  });
  it("rejects bash-style $NAME (no curly) as a security measure", () => {
    expect(() => expandEnvVars("$FOO", { FOO: "x" })).toThrow();
  });
});
