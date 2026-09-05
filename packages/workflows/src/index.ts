import { task } from "better-trigger";

export interface SmokePayload {
  message: string;
}

export const workflowSmoke = task({
  id: "agent-flow.smoke.v1",
  name: "Agent Flow runtime smoke check",
  replay: "strict",
  schema: {
    parse(input: unknown): SmokePayload {
      if (
        typeof input !== "object" ||
        input === null ||
        !("message" in input) ||
        typeof input.message !== "string" ||
        input.message.length === 0 ||
        input.message.length > 1_000
      ) {
        throw new Error(
          "Smoke payload requires a message between 1 and 1000 characters.",
        );
      }
      return { message: input.message };
    },
  },
  run: async (payload, ctx) => {
    // Pure output exercises the durable ledger without changing Herdr state.
    // Wrapping a pane mutation in ctx.step alone does not make it exactly-once.
    return ctx.step("echo-message", () => ({ message: payload.message }));
  },
});

export const workflowTasks = [workflowSmoke];

export * from "./issue-agent";
