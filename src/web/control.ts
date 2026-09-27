import { Hono } from "hono";
import type { CallManager } from "../core/call-manager";
import { logger } from "../core/log";

const log = logger("control");

/**
 * Operator API for deploys (scripts/control.ts). Served on its own loopback-only listener, never
 * through the tunnel: inside the container it's reachable only via `docker compose exec`.
 */
export function controlRoutes(manager: CallManager) {
  const app = new Hono();
  const status = () => ({ accepting: manager.accepting, activeCalls: manager.activeCalls });

  app.get("/status", (c) => c.json(status()));
  app.post("/drain", (c) => {
    const ttl = Number(c.req.query("ttl") ?? 1200);
    if (!Number.isFinite(ttl) || ttl <= 0) return c.text("ttl must be a positive number of seconds", 400);
    manager.drain(ttl * 1000);
    log.info(`draining: new calls rejected for up to ${ttl} s`);
    return c.json(status());
  });
  app.post("/resume", (c) => {
    manager.resume();
    log.info("resumed: accepting calls");
    return c.json(status());
  });
  return app;
}
