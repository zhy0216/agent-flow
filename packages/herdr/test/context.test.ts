import { describe, expect, test } from "bun:test";
import { requireHerdrContext } from "../src";

describe("Herdr caller boundary", () => {
  test("rejects execution outside Herdr even when IDs are supplied", () => {
    expect(() =>
      requireHerdrContext({
        HERDR_ENV: "0",
        HERDR_WORKSPACE_ID: "workspace",
        HERDR_TAB_ID: "tab",
        HERDR_PANE_ID: "pane",
      }),
    ).toThrow("inside a Herdr-managed pane");
  });

  test("rejects missing caller IDs instead of falling back to focused pane", () => {
    expect(() => requireHerdrContext({ HERDR_ENV: "1" })).toThrow(
      "caller context is incomplete",
    );
  });

  test("preserves opaque caller IDs", () => {
    expect(
      requireHerdrContext({
        HERDR_ENV: "1",
        HERDR_WORKSPACE_ID: "workspace-opaque",
        HERDR_TAB_ID: "tab-opaque",
        HERDR_PANE_ID: "pane-opaque",
      }),
    ).toEqual({
      workspaceId: "workspace-opaque",
      tabId: "tab-opaque",
      paneId: "pane-opaque",
    });
  });
});
