#!/usr/bin/env bun
// Copies production data to the laptop for bug investigations, over `ssh scamsitter-vps` (Cloudflare
// Access; docs/deploy.md) with the admin login's sudo. Everything lands in data/prod/ (gitignored).
//   bun run prod get-db                    a consistent copy of the database → data/prod/scamsitter-<time>.db
//   bun run prod get-logs [--days <n>]     log files changed in the last n days (default 3) → data/prod/logs/
//   bun run prod get-call-log <call id>    one call's log file → data/prod/logs/
//   bun run prod get-recording <call id>   the call's recordings → data/prod/recordings/
// PROD_SSH_HOST overrides the ssh host (default scamsitter-vps).
import { Database } from "bun:sqlite";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const HOST = process.env.PROD_SSH_HOST || "scamsitter-vps";
const DATA = "/var/lib/scamsitter"; // /data in the container
const PROJECT = "/opt/scamsitter"; // the deploy's compose project (deploy/vps/scamsitter-deploy)
const OUT = "data/prod";

const USAGE = "usage: bun run prod get-db | get-logs [--days <n>] | get-call-log <call id> | get-recording <call id>";
const { positionals, values } = parseArgs({ args: Bun.argv.slice(2), allowPositionals: true, options: { days: { type: "string" } } });
const [cmd, id] = positionals;

/** Runs `script` as root on the VPS; its stdout is the returned stream, its stderr passes through. */
function remote(script: string) {
  // The script goes in single quotes to `sudo sh -c`, so it must not contain any.
  if (script.includes("'")) throw new Error("remote script can't contain single quotes");
  return Bun.spawn(["ssh", HOST, `sudo -n sh -c '${script}'`], { stdout: "pipe", stderr: "inherit", stdin: "ignore" });
}

function failed(code: number, what: string): string | null {
  if (code === 3) return `${what}: nothing found`;
  return code === 0 ? null : `${what} failed (ssh exit ${code})`;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const callId = (v: string | undefined) => {
  // Interpolated into the remote shell script: call ids are UUIDs, so allow nothing else.
  if (!v || !/^[A-Za-z0-9_-]+$/.test(v)) fail(USAGE);
  return v;
};

/** Copies the files `find` selects in the VPS folder `dir` into the local `into` (a tar.gz stream); returns their paths. */
async function pull(dir: string, find: string, into: string, what: string): Promise<string[]> {
  mkdirSync(into, { recursive: true });
  const ssh = remote(`cd ${dir} && set -- $(find . -maxdepth 1 -type f ${find}) && [ $# -gt 0 ] || exit 3; tar -cz "$@"`);
  // -v lists each file: "x ./name" on stderr (bsdtar, macOS) or "./name" on stdout (GNU tar).
  const tar = Bun.spawn(["tar", "-xzvf", "-", "-C", into], { stdin: ssh.stdout, stdout: "pipe", stderr: "pipe" });
  const [code, listed, errs, tarCode] = await Promise.all([ssh.exited, new Response(tar.stdout).text(), new Response(tar.stderr).text(), tar.exited]);
  const err = failed(code, what);
  if (err) fail(err);
  if (tarCode !== 0) fail(`${what}: unpacking failed\n${errs}`);
  return `${listed}\n${errs}`
    .split("\n")
    .map((l) => l.trim().replace(/^x /, "").replace(/^\.\//, ""))
    .filter(Boolean)
    .sort()
    .map((f) => join(into, f));
}

const show = (files: string[]) => {
  for (const f of files) console.log(f);
};

switch (cmd) {
  case "get-db": {
    mkdirSync(OUT, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join(OUT, `scamsitter-${stamp}.db`);
    // VACUUM INTO inside the running container (scripts/backup-db.ts): consistent while calls write.
    const tmp = `backups/.pull-${stamp}.db`;
    const ssh = remote(
      `trap "rm -f ${DATA}/${tmp}" EXIT; ` +
        `docker compose --project-directory ${PROJECT} exec -T scamsitter bun scripts/backup-db.ts /data/${tmp} >&2 && gzip -c ${DATA}/${tmp}`,
    );
    const written = await Bun.write(`${dest}.tmp`, new Response(ssh.stdout.pipeThrough(new DecompressionStream("gzip")))).catch((e: Error) => e);
    const err = failed(await ssh.exited, "get-db") ?? (written instanceof Error ? `get-db: ${written.message}` : null);
    if (err) {
      rmSync(`${dest}.tmp`, { force: true });
      fail(err);
    }
    renameSync(`${dest}.tmp`, dest);
    const db = new Database(dest, { readonly: true });
    const ok = db.query<{ quick_check: string }, []>("PRAGMA quick_check").get()?.quick_check;
    const calls = db.query<{ n: number }, []>("SELECT count(*) AS n FROM calls").get()?.n;
    db.close();
    if (ok !== "ok") fail(`${dest}: integrity check failed: ${ok}`);
    console.log(`${dest} (${(Bun.file(dest).size / 1e6).toFixed(1)} MB, ${calls} calls)`);
    break;
  }
  case "get-logs": {
    const days = Number(values.days ?? 3);
    if (!Number.isInteger(days) || days < 1) fail("--days needs a whole number of days");
    show(await pull(`${DATA}/logs`, `-name "*.jsonl" -mtime -${days}`, join(OUT, "logs"), "get-logs"));
    break;
  }
  case "get-call-log":
    show(await pull(`${DATA}/logs`, `-name "call-*-${callId(id)}.jsonl"`, join(OUT, "logs"), `log of call ${id}`));
    break;
  case "get-recording":
    show(await pull(`${DATA}/recordings`, `-name "${callId(id)}.*"`, join(OUT, "recordings"), `recording of call ${id}`));
    break;
  default:
    fail(USAGE);
}
