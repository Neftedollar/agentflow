import { describe, expect, it, vi } from "vitest";
import { ProgressStreamer } from "../progress-streamer.js";

describe("ProgressStreamer", () => {
  it("emits task_started with progressToken", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, "tok-123");
    streamer.taskStarted("plan");
    expect(send).toHaveBeenCalledWith({
      progressToken: "tok-123",
      progress: 0,
      message: expect.stringContaining("task_started"),
      meta: { phase: "task_started", task: "plan" },
    });
  });

  it("emits task_completed with metrics", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, "tok-123");
    streamer.taskCompleted("plan", {
      costUsd: 0.27,
      tokensIn: 8000,
      tokensOut: 2000,
    });
    const payload = send.mock.calls[0]?.[0];
    expect(payload.meta).toMatchObject({
      phase: "task_completed",
      task: "plan",
      metrics: { costUsd: 0.27 },
    });
  });

  it("emits task_failed", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, "tok-123");
    streamer.taskFailed("build", "TypeError: x");
    expect(send.mock.calls[0]?.[0].meta.phase).toBe("task_failed");
  });

  it("emits loop_iteration", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, "tok-123");
    streamer.loopIteration(2);
    expect(send.mock.calls[0]?.[0].meta).toEqual({
      phase: "loop_iteration",
      iteration: 2,
    });
  });

  it("emits awaiting_elicitation", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, "tok-123");
    streamer.awaitingElicitation("verify", "Approve to ship?");
    expect(send.mock.calls[0]?.[0].meta).toMatchObject({
      phase: "awaiting_elicitation",
      task: "verify",
    });
  });

  it("no-ops when progressToken is undefined", () => {
    const send = vi.fn();
    const streamer = new ProgressStreamer(send, undefined);
    streamer.taskStarted("plan");
    expect(send).not.toHaveBeenCalled();
  });
});
