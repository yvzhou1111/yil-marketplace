import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the logger so we can assert calls without spinning up pino.
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
  level: "info",
};
const childLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
mockLogger.child.mockReturnValue(childLogger);

vi.mock("@/lib/logger", () => ({
  requestLogger: () => childLogger,
}));

// `next/server` imports `server.edge` runtime types — stub the bits we use.
vi.mock("next/server", () => {
  class FakeNextResponse {
    status: number;
    headers: Map<string, string>;
    body: unknown;
    constructor(body?: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.status = init?.status ?? 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}));
      this.body = body;
    }
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new FakeNextResponse(body, init);
    }
  }
  return { NextResponse: FakeNextResponse };
});

import { startRequest, finishRequest, withRequestLogger, REQUEST_ID_HEADER } from "./request-log";

function makeReq(opts: { method?: string; url?: string; incomingId?: string | null } = {}) {
  const headers = new Map<string, string>();
  if (opts.incomingId) headers.set(REQUEST_ID_HEADER, opts.incomingId);
  return {
    method: opts.method ?? "GET",
    url: opts.url ?? "https://example.com/api/health",
    headers: {
      get: (k: string) => headers.get(k.toLowerCase()) ?? null,
    },
  } as unknown as Parameters<typeof startRequest>[0];
}

describe("startRequest", () => {
  beforeEach(() => {
    mockLogger.info.mockClear();
    mockLogger.child.mockClear();
    childLogger.info.mockClear();
    childLogger.error.mockClear();
  });

  it("mints a request id when none is supplied", () => {
    const { ctx, headers } = startRequest(makeReq());
    expect(ctx.requestId).toMatch(/^[0-9a-f-]{36}$/); // uuid v4
    expect(headers[REQUEST_ID_HEADER]).toBe(ctx.requestId);
  });

  it("reuses an incoming x-request-id header", () => {
    const { ctx, headers } = startRequest(makeReq({ incomingId: "incoming-id-123" }));
    expect(ctx.requestId).toBe("incoming-id-123");
    expect(headers[REQUEST_ID_HEADER]).toBe("incoming-id-123");
  });

  it("logs a request.start event", () => {
    startRequest(makeReq({ method: "POST", url: "https://example.com/api/listings" }));
    expect(childLogger.info).toHaveBeenCalledTimes(1);
    const [firstArg] = childLogger.info.mock.calls[0];
    expect(firstArg).toMatchObject({ event: "request.start", method: "POST", route: "/api/listings" });
  });
});

describe("finishRequest", () => {
  beforeEach(() => {
    childLogger.info.mockClear();
    childLogger.error.mockClear();
  });

  it("attaches x-request-id to the response and logs request.finish", () => {
    const { ctx } = startRequest(makeReq({ incomingId: "id-42" }));
    const res = finishRequest(ctx, { headers: new Map<string, string>(), status: 200 } as never, 200, { userId: 7 });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("id-42");
    expect(childLogger.info).toHaveBeenCalledTimes(2); // start + finish
    const [, msg] = childLogger.info.mock.calls[1];
    expect(msg).toBe("request completed");
  });
});

describe("withRequestLogger", () => {
  beforeEach(() => {
    childLogger.info.mockClear();
    childLogger.error.mockClear();
  });

  it("returns the handler's response and logs success", async () => {
    const handler = vi.fn().mockResolvedValue({ res: { headers: new Map(), status: 201 } });
    await withRequestLogger(makeReq(), handler as never);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(childLogger.info).toHaveBeenCalledTimes(2);
  });

  it("catches thrown errors, returns 500, logs the error", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const res = await withRequestLogger(makeReq({ incomingId: "fail-id" }), handler as never);
    expect(res.status).toBe(500);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe("fail-id");
    expect(childLogger.error).toHaveBeenCalledTimes(1);
  });
});