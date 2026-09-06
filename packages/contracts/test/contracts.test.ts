import { expect, test } from "bun:test";
import {
  canTransitionIssue,
  canTransitionRun,
  parseChecks,
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
test("checks preserve executable argv including empty and literal shell-looking arguments", () => {
  const checks = [
    [
      "bun",
      "test",
      "",
      " ",
      'a"b',
      "it's",
      "C:\\new\\test",
      "line\nbreak\r\n",
      "\t",
      "$(id)",
      "`id`",
      "$HOME",
      "|",
      "&&",
    ],
    ["git", "diff", "--check"],
  ];
  expect(parseChecks(checks)).toEqual(checks);
  expect(
    parseProject({ name: "Repo", repoKey: "repo", checks }).checks,
  ).toEqual(checks);
  expect(parseChecks([])).toEqual([]);
  expect(parseProject({ name: "Repo", repoKey: "repo" }).checks).toEqual([]);
  const boundary = Array.from({ length: 20 }, () => [
    "bun",
    ...Array.from({ length: 49 }, () => "x".repeat(1000)),
  ]);
  expect(parseChecks(boundary)).toEqual(boundary);
});
test.each([
  [null, "array"],
  ["bun test", "array"],
  [["bun test"], "argv array"],
  [[[]], "argv array"],
  [Array(1), "argv array"],
  [[["bun", ...Array(1)]], "string"],
  [[["npm", "test"]], "program must be bun or git"],
  [[["/usr/bin/git"]], "program must be bun or git"],
  [[["bun test"]], "program must be bun or git"],
  [[[""]], "program must be bun or git"],
  [[[" bun"]], "program must be bun or git"],
  [[["bun", 1]], "string"],
  [[["git", null]], "string"],
  [[["bun\0"]], "NUL"],
  [[["bun", "a\0b"]], "NUL"],
  [[Array.from({ length: 51 }, () => "bun")], "1 to 50"],
  [Array.from({ length: 21 }, () => ["git"]), "at most 20"],
  [[["bun", "x".repeat(1001)]], "at most 1000"],
])("project validation rejects malformed checks %#", (checks, message) => {
  expect(() => parseChecks(checks)).toThrow(String(message));
  expect(() => parseProject({ name: "Repo", repoKey: "repo", checks })).toThrow(
    String(message),
  );
});
test("state machines preserve terminal runs and require review transitions", () => {
  expect(canTransitionRun("blocked", "running")).toBe(true);
  expect(canTransitionRun("succeeded", "running")).toBe(false);
  expect(canTransitionRun("queued", "succeeded")).toBe(false);
  expect(canTransitionIssue("todo", "done")).toBe(false);
  expect(canTransitionIssue("in-review", "done")).toBe(true);
});
