#!/usr/bin/env bun
// Talks to the running server's loopback control API (src/web/control.ts). Used by deploys:
//   bun scripts/control.ts status
//   bun scripts/control.ts drain [--wait <s>] [--ttl <s>]   reject new calls; with --wait, block until
//                                                           no calls are left (exit 75 and resume if
//                                                           they don't end in time)
//   bun scripts/control.ts resume
const port = Number(process.env.CONTROL_PORT ?? 8788);
const base = `http://127.0.0.1:${port}`;
const [cmd, ...rest] = Bun.argv.slice(2);

function flag(name: string, fallback: number): number {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = Number(rest[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} needs a number of seconds`);
  return v;
}

type Status = { accepting: boolean; activeCalls: number };

async function call(method: "GET" | "POST", path: string): Promise<Status> {
  const res = await fetch(`${base}${path}`, { method });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Status;
}

async function drain(waitS: number, ttlS: number) {
  let s = await call("POST", `/drain?ttl=${ttlS}`);
  console.log(`draining (${s.activeCalls} active call(s)); new calls are rejected for up to ${ttlS} s`);
  if (!rest.includes("--wait")) return;
  // Interrupted (e.g. the deploy's SSH session dropped): take calls again rather than wait for the TTL.
  const bail = async () => {
    await call("POST", "/resume").catch(() => undefined);
    process.exit(130);
  };
  process.on("SIGINT", bail);
  process.on("SIGTERM", bail);
  process.on("SIGHUP", bail);
  const end = Date.now() + waitS * 1000;
  let last = -1;
  while (s.activeCalls > 0) {
    if (Date.now() > end) {
      await call("POST", "/resume");
      console.error(`still ${s.activeCalls} active call(s) after ${waitS} s: resumed, deploy deferred`);
      process.exit(75);
    }
    if (s.activeCalls !== last) console.log(`waiting for ${s.activeCalls} active call(s) to end…`);
    last = s.activeCalls;
    await Bun.sleep(2000);
    s = await call("GET", "/status");
  }
  console.log("no active calls");
}

try {
  switch (cmd) {
    case "status":
      console.log(JSON.stringify(await call("GET", "/status")));
      break;
    case "drain": {
      const wait = flag("wait", 900);
      await drain(wait, flag("ttl", wait + 300));
      break;
    }
    case "resume":
      console.log(JSON.stringify(await call("POST", "/resume")));
      break;
    default:
      console.error("usage: bun scripts/control.ts status | drain [--wait <s>] [--ttl <s>] | resume");
      process.exit(2);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
