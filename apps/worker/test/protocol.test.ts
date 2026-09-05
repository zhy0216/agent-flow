import { expect, test } from "bun:test";
import { logDelta } from "@agent-flow/workflows";
import { parseServerMessage } from "../src/connection";

test("control messages reject another worker and inconsistent run snapshots", () => {
  expect(() =>
    parseServerMessage(
      {
        version: 1,
        type: "run.cancel",
        workerId: "other",
        requestId: "c",
        runId: "r",
        payload: { reason: "stop" },
      },
      "worker",
    ),
  ).toThrow("identity");
  expect(() =>
    parseServerMessage(
      {
        version: 1,
        type: "run.submit",
        workerId: "worker",
        requestId: "c",
        runId: "r",
        payload: { run: { id: "wrong" } },
      },
      "worker",
    ),
  ).toThrow("snapshots");
  expect(() =>
    parseServerMessage(
      {
        version: 1,
        type: "event.ack",
        workerId: "worker",
        requestId: "c",
        runId: "r",
        payload: { sequence: -1 },
      },
      "worker",
    ),
  ).toThrow("cursor");
});

test("terminal snapshots produce incremental output and explicit scrollback gaps", () => {
  expect(logDelta("first\n", "first\nsecond\n")).toEqual({
    text: "second\n",
    reset: false,
  });
  const shared = "This is a shared line that exceeds thirty-two bytes.\n";
  expect(logDelta(`old\n${shared}`, `${shared}new\n`)).toEqual({
    text: "new\n",
    reset: false,
  });
  expect(logDelta("lost scrollback", "new snapshot")).toEqual({
    text: "new snapshot",
    reset: true,
  });
  expect(logDelta("same", "same")).toEqual({ text: "", reset: false });
});
