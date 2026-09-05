import { expect, test } from "bun:test";
import {
  canTransitionIssue,
  canTransitionRun,
  parseIssue,
  parseProject,
  parseWorkerMessage,
} from "../src/index.ts";

test("runtime schemas reject malformed repo commands and protocol messages", () => {
  expect(() =>
    parseProject({ name: "Repo", repoKey: "../../elsewhere" }),
  ).toThrow();
  expect(() =>
    parseProject({ name: "Repo", repoKey: "repo", checks: ["bun test"] }),
  ).toThrow();
  expect(
    parseProject({ name: "Repo", repoKey: "repo", checks: [["bun", "test"]] }),
  ).toMatchObject({ worktree: true });
  expect(() =>
    parseIssue({ projectId: "p", title: "", priority: "whatever" }),
  ).toThrow();
  expect(() =>
    parseWorkerMessage({
      version: 2,
      type: "worker.heartbeat",
      requestId: "r",
      workerId: "w",
      payload: { capacity: 1 },
    }),
  ).toThrow();
  expect(() =>
    parseWorkerMessage({
      version: 1,
      type: "run.event",
      requestId: "r",
      workerId: "w",
      runId: "run",
      sequence: 0,
      payload: {
        type: "log",
        timestamp: new Date().toISOString(),
        payload: {},
      },
    }),
  ).toThrow();
});
test("state machines preserve terminal runs and require review transitions", () => {
  expect(canTransitionRun("blocked", "running")).toBe(true);
  expect(canTransitionRun("succeeded", "running")).toBe(false);
  expect(canTransitionRun("queued", "succeeded")).toBe(false);
  expect(canTransitionIssue("todo", "done")).toBe(false);
  expect(canTransitionIssue("in-review", "done")).toBe(true);
});
