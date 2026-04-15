import type { TasksMap } from "@ageflow/core";
import { describe, expect, it } from "vitest";
import { findBoundaryTasks } from "../dag-boundary.js";

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
    expect(() => findBoundaryTasks(tasks, undefined, "c")).toThrow(
      /multiple root tasks/,
    );
  });

  it("throws if DAG has >1 leaf and no outputTask", () => {
    const tasks: TasksMap = {
      a: mkTask(),
      b: mkTask(["a"]),
      c: mkTask(["a"]),
    };
    expect(() => findBoundaryTasks(tasks, "a", undefined)).toThrow(
      /multiple leaf tasks/,
    );
  });

  it("throws if inputTask not in tasks", () => {
    const tasks: TasksMap = { a: mkTask() };
    expect(() => findBoundaryTasks(tasks, "nonexistent", "a")).toThrow(
      /inputTask "nonexistent" not found/,
    );
  });

  it("throws if outputTask not in tasks", () => {
    const tasks: TasksMap = { a: mkTask() };
    expect(() => findBoundaryTasks(tasks, "a", "nonexistent")).toThrow(
      /outputTask "nonexistent" not found/,
    );
  });
});
