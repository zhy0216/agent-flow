import "reflect-metadata";
import {
  enumeration,
  type HealthResponse,
  integer,
  issueStatuses,
  object,
  parseIssue,
  parseProject,
  parseResolveRun,
  parseSubmitRun,
  string,
  ValidationError,
} from "@agent-flow/contracts";
import { Database, DomainError } from "@agent-flow/db";
import { Zebra, type ZebraRequest } from "@zebra-web/zebra";
import { ControlService } from "./control.ts";

export interface AppOptions {
  database?: Database;
  allowedOrigins?: string[];
}
function loopback(hostname: string) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}
function errorResponse(error: unknown): Response {
  if (error instanceof DomainError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  if (error instanceof ValidationError || error instanceof SyntaxError)
    return Response.json(
      { error: { code: "invalid_input", message: error.message } },
      { status: 400 },
    );
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 400
  )
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: error instanceof Error ? error.message : "Invalid request",
        },
      },
      { status: 400 },
    );
  console.error("API request failed", error);
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "The server could not complete this request",
      },
    },
    { status: 500 },
  );
}
export function createApp(options: AppOptions = {}): Zebra {
  const app = new Zebra({ body: { maxSize: 256_000 }, gracePeriod: 500 });
  const db = options.database;
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
  );
  const guard = (request: ZebraRequest): Response | undefined => {
    if (!loopback(request.url.hostname))
      return Response.json(
        {
          error: {
            code: "local_only",
            message: "Agent Flow is restricted to loopback access",
          },
        },
        { status: 403 },
      );
    const origin = request.headers.get("origin");
    if (origin && origin !== request.url.origin && !allowedOrigins.has(origin))
      return Response.json(
        {
          error: {
            code: "invalid_origin",
            message: "Request origin is not allowed",
          },
        },
        { status: 403 },
      );
    if (request.headers.get("sec-fetch-site") === "cross-site")
      return Response.json(
        {
          error: {
            code: "invalid_origin",
            message: "Cross-site requests are not allowed",
          },
        },
        { status: 403 },
      );
    if (
      ["POST", "PUT", "PATCH"].includes(request.raw.method) &&
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      return Response.json(
        {
          error: {
            code: "invalid_content_type",
            message: "Commands require application/json",
          },
        },
        { status: 415 },
      );
  };
  app.get("/api/health", () =>
    Response.json({
      status: "ok",
      service: "agent-flow-server",
    } satisfies HealthResponse),
  );
  app.use(async (request: ZebraRequest, next) => {
    if (request.url.pathname === "/api/health") return next();
    const denied = guard(request);
    if (denied) return denied;
    if (!db)
      return Response.json(
        {
          error: {
            code: "database_unavailable",
            message: "Configure DATABASE_URL to enable the workspace",
          },
        },
        { status: 503 },
      );
    try {
      return await next();
    } catch (error) {
      return errorResponse(error);
    }
  });
  if (!db) {
    app.get("/api/*path", () =>
      Response.json(
        {
          error: {
            code: "database_unavailable",
            message: "Configure DATABASE_URL to enable the workspace",
          },
        },
        { status: 503 },
      ),
    );
    return app;
  }
  const control = new ControlService(db);
  app.injectValue(Database, db);
  app.injectValue(ControlService, control);
  app.on("ready", () => control.start());
  app.on("shutdown", () => control.stop());
  const route =
    (handler: (req: ZebraRequest) => unknown | Promise<unknown>) =>
    async (req: ZebraRequest) => {
      try {
        const value = await handler(req);
        return value instanceof Response ? value : Response.json(value);
      } catch (error) {
        return errorResponse(error);
      }
    };
  app.get(
    "/api/projects",
    route(() => db.projects()),
  );
  app.get(
    "/api/projects/:id",
    route((req) => db.project(req.params.id as string)),
  );
  app.post(
    "/api/projects",
    route(async (req) => {
      const project = await db.createProject(parseProject(await req.json()));
      control.publish({ entity: "project", id: project.id });
      return Response.json(project, { status: 201 });
    }),
  );
  app.patch(
    "/api/projects/:id",
    route(async (req) => {
      const current = await db.project(req.params.id as string);
      const project = await db.updateProject(
        current.id,
        parseProject({ ...current, ...object(await req.json()) }),
      );
      control.publish({ entity: "project", id: project.id });
      return project;
    }),
  );
  app.delete(
    "/api/projects/:id",
    route(async (req) => {
      await db.deleteProject(req.params.id as string);
      control.publish({ entity: "project", id: req.params.id as string });
      return new Response(null, { status: 204 });
    }),
  );
  app.get(
    "/api/issues",
    route((req) => {
      const status =
        req.query.status === undefined
          ? undefined
          : enumeration(req.query.status, issueStatuses, "status");
      return db.issues({
        projectId: req.query.projectId,
        status,
        q: req.query.q,
      });
    }),
  );
  app.get(
    "/api/issues/:id",
    route((req) => db.issue(req.params.id as string)),
  );
  app.post(
    "/api/issues",
    route(async (req) => {
      const issue = await db.createIssue(parseIssue(await req.json()));
      control.publish({ entity: "issue", id: issue.id });
      return Response.json(issue, { status: 201 });
    }),
  );
  app.patch(
    "/api/issues/:id",
    route(async (req) => {
      const current = await db.issue(req.params.id as string);
      const issue = await db.updateIssue(
        current.id,
        parseIssue({ ...current, ...object(await req.json()) }),
      );
      control.publish({ entity: "issue", id: issue.id });
      return issue;
    }),
  );
  app.delete(
    "/api/issues/:id",
    route(async (req) => {
      await db.deleteIssue(req.params.id as string);
      control.publish({ entity: "issue", id: req.params.id as string });
      return new Response(null, { status: 204 });
    }),
  );
  app.get(
    "/api/workers",
    route(() => db.workers()),
  );
  app.post(
    "/api/workers/pairing",
    route(async (req) => {
      const input = object(await req.json());
      return db.createPairing(
        input.name === undefined ? undefined : string(input.name, "name", 200),
      );
    }),
  );
  app.post(
    "/api/workers/pair",
    route(async (req) => {
      const input = object(await req.json());
      const result = await db.pair(
        string(input.code, "code", 200),
        string(input.name, "name", 200),
      );
      control.publish({ entity: "worker", id: result.workerId });
      return Response.json(result, { status: 201 });
    }),
  );
  app.get(
    "/api/runs",
    route((req) => db.runs(req.query.issueId)),
  );
  app.get(
    "/api/issues/:id/runs",
    route(async (req) => {
      await db.issue(req.params.id as string);
      return db.runs(req.params.id);
    }),
  );
  app.get(
    "/api/runs/:id",
    route((req) => db.run(req.params.id as string)),
  );
  app.post(
    "/api/runs",
    route(async (req) => {
      const run = await db.submitRun(parseSubmitRun(await req.json()));
      control.publish({ entity: "run", id: run.id });
      control.publish({ entity: "issue", id: run.issueId });
      await control.flush(run.workerId);
      return Response.json(run, { status: 201 });
    }),
  );
  app.get(
    "/api/runs/:id/events",
    route((req) =>
      db.events(
        req.params.id as string,
        integer(Number(req.query.after ?? 0), "after"),
        integer(Number(req.query.limit ?? 100), "limit", 1, 200),
      ),
    ),
  );
  app.post(
    "/api/runs/:id/cancel",
    route(async (req) => {
      const input = object(await req.json());
      const run = await db.command(req.params.id as string, "run.cancel", {
        reason: string(input.reason ?? "Cancelled by user", "reason", 10_000),
      });
      control.publish({ entity: "run", id: run.id });
      await control.flush(run.workerId);
      return run;
    }),
  );
  app.post(
    "/api/runs/:id/resolve",
    route(async (req) => {
      const run = await db.command(
        req.params.id as string,
        "run.resolve",
        parseResolveRun(await req.json()),
      );
      control.publish({ entity: "run", id: run.id });
      await control.flush(run.workerId);
      return run;
    }),
  );
  app.post(
    "/api/runs/:id/retry",
    route(async (req) => {
      const input = object(await req.json());
      const run = await db.retry(
        req.params.id as string,
        string(input.idempotencyKey, "idempotencyKey", 200),
      );
      control.publish({ entity: "run", id: run.id });
      control.publish({ entity: "issue", id: run.issueId });
      await control.flush(run.workerId);
      return Response.json(run, { status: 201 });
    }),
  );
  app.post(
    "/api/runs/:id/review",
    route(async (req) => {
      const input = object(await req.json());
      const run = await db.review(
        req.params.id as string,
        enumeration(input.decision, ["approve", "reject"], "review decision"),
        string(input.note ?? "", "note", 10_000, true),
      );
      control.publish({ entity: "run", id: run.id });
      control.publish({ entity: "issue", id: run.issueId });
      return run;
    }),
  );
  app.get("/api/events", (req) => {
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const enqueue = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            cleanup();
          }
        };
        enqueue(": connected; refetch snapshots after every reconnect\n\n");
        const unsubscribe = control.subscribe(
          (change) => enqueue(`data: ${JSON.stringify(change)}\n\n`),
          () => {
            cleanup();
            try {
              controller.close();
            } catch {
              /* Stream already closed. */
            }
          },
        );
        const timer = setInterval(() => enqueue(": heartbeat\n\n"), 10_000);
        const abort = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            /* Already closed. */
          }
        };
        cleanup = () => {
          unsubscribe();
          clearInterval(timer);
          req.signal.removeEventListener("abort", abort);
        };
        req.signal.addEventListener("abort", abort, { once: true });
        if (req.signal.aborted) abort();
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
  app.ws("/api/workers/connect", {
    onUpgrade: { database: Database },
    async upgrade(req, { database }) {
      // Zebra upgrades bypass app.use; verify both origin and token here.
      if (guard(req)) return false;
      const token = /^Bearer (.+)$/.exec(
        req.headers.get("authorization") ?? "",
      )?.[1];
      if (!token) return false;
      const workerId = await database.authenticate(token);
      return workerId ? { workerId, connectionId: crypto.randomUUID() } : false;
    },
    open(ws, data) {
      control.open(data.workerId, data.connectionId, ws);
    },
    message(_ws, data, message) {
      control.receive(data.workerId, data.connectionId, message);
    },
    close(_ws, data) {
      return control.close(data.workerId, data.connectionId);
    },
  });
  return app;
}
