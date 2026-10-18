#!/usr/bin/env bun
// Consistent copy of the SQLite database while the server runs (VACUUM INTO reads a snapshot;
// WAL mode lets it run alongside writes). Usage: bun scripts/backup-db.ts <dest.db>
// Writes <dest>.tmp and renames it, so a failed backup never leaves a half-written <dest>.
import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const dest = Bun.argv[2];
if (!dest) {
  console.error("usage: bun scripts/backup-db.ts <dest.db>");
  process.exit(2);
}
const src = join(process.env.DATA_DIR ?? "./data", "callsitter.db");
if (!existsSync(src)) {
  console.log(`no database at ${src} yet: nothing to back up`);
  process.exit(0);
}
const tmp = `${dest}.tmp`;
rmSync(tmp, { force: true });
// Not readonly: a WAL database needs its -shm, which a read-only connection can't create.
const db = new Database(src, { readwrite: true, create: false });
try {
  db.run("PRAGMA busy_timeout = 5000;");
  db.run("VACUUM INTO ?", [tmp]);
} finally {
  db.close();
}
renameSync(tmp, dest);
console.log(`backed up ${src} → ${dest}`);
