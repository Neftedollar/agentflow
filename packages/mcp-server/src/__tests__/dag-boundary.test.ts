import type { TasksMap } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { findBoundaryTasks } from "../dag-boundary.js";
import { ErrorCode, McpServerError } from "../errors.js";

// Minimal TaskDef stubs for testing; actual implementation only reads dependsOn.
// biome-ignore lint/suspicious/noExplicitAny: narrow test stub
const mkTask = (deps?: string[]): any => ({
  agent: { input: {}, output: {} },
  dependsOn: deps,
});

describe("findBoundaryTasks", () => {
  it("finds unique root and leaf in linear DAG", () => {
    const tasks: TasksMap = {
      a: mkTask(),
      b: mkTask(["a"]),
      c: mkTask(["b"]),
    };
    expect(findBoundaryTasks(tasks, undefined, undefined)).toEqual({
      inputTask: "a",
      outputTask: "c",
    });
  });

  it("uses explicit inputTask/outputTask overrides", () => {
    const tasks: TasksMap = {
      a: mkTask(),
      b: mkTask(["a"]),
      c: mkTask(["b"]),
    };
    expect(findBoundaryTasks(tasks, "b", "c")).toEqual({
      inputTask: "b",
      outputTask: "c",
    });
  });

  it("throws if DAG has >1 root and no inputTask", () => {
    const tasks: TasksMap = {
      a: mkTask(),
      b: mkTask(),
      c: mkTask(["a", "b"]),
    };
    let caught: unknown;
    try {
      findBoundaryTasks(tasks, undefined, "c");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpServerError);
    expect((caught as McpServerError).errorCode).toBe(ErrorCode.DAG_INVALID);
    expect((caught as McpServerError).message).toMatch(/multiple root tasks/);
  });

  it("throws if DAG has >1 leaf and no outputTask", () => {
    const tasks: TasksMap = {
      a: mkTask(),
      b: mkTask(["a"]),
      c: mkTask(["a"]),
    };
    let caught: unknown;
    try {
      findBoundaryTasks(tasks, "a", undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpServerError);
    expect((caught as McpServerError).errorCode).toBe(ErrorCode.DAG_INVALID);
    expect((caught as McpServerError).message).toMatch(/multiple leaf tasks/);
  });

  it("throws if inputTask not in tasks", () => {
    const tasks: TasksMap = { a: mkTask() };
    let caught: unknown;
    try {
      findBoundaryTasks(tasks, "nonexistent", "a");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpServerError);
    expect((caught as McpServerError).errorCode).toBe(ErrorCode.DAG_INVALID);
    expect((caught as McpServerError).message).toMatch(
      /inputTask "nonexistent" not found/,
    );
  });

  it("throws if outputTask not in tasks", () => {
    const tasks: TasksMap = { a: mkTask() };
    let caught: unknown;
    try {
      findBoundaryTasks(tasks, "a", "nonexistent");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McpServerError);
    expect((caught as McpServerError).errorCode).toBe(ErrorCode.DAG_INVALID);
    expect((caught as McpServerError).message).toMatch(
      /outputTask "nonexistent" not found/,
    );
  });
});
