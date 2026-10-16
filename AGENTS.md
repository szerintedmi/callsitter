# CallSitter

AI call screener: Telnyx media stream ↔ OpenAI Live (gpt-live-1), TypeSafe Jev classification on caller pauses, a deterministic call flow (`config/call-flow.yaml` rules over Jev answers), GPT-6 Luna for guidance/tools. See README.md.

## Commands

- `bun test`: all tests, including `test/e2e.test.ts` (the steel thread with faked vendors)
- `bun run typecheck`, `bun run check-config`
- `bun run replay <transcript> --fake`: offline Jev/call-flow replay
- Production: `Dockerfile`, `deploy/compose.yaml`, VPS scripts in `deploy/vps/`, `.github/workflows/`; runbook in `docs/deploy.md`. A deploy drains calls through the loopback control API (`src/web/control.ts`, `scripts/control.ts`) before replacing the container. Files the image needs must also be allowed in `.dockerignore`.
- `bun run prod get-db | get-logs [--days n] | get-call-log <id> | get-recording <id>`: copy production data into `data/prod/` for bug investigations (read-only, over `ssh callsitter-vps`; docs/deploy.md). Query the copies locally with `sqlite3`/`jq`.
- `bun run eval [names…] [--runs N]`: on-demand evals against the real vendors (`evals/cases.yaml`); run after prompt or Jev changes, not every time. Eval-only code stays in `evals/`, not in `src/`.

## Conventions

- `src/core/` must stay runtime-agnostic: no Bun, Node or `Buffer` APIs, only WebCrypto, fetch and timers. It targets a later Cloudflare Workers + Durable Object port. Bun-specific code goes in `src/adapters/*` and `src/runtime/`.
- Vendor APIs (Live, Jev, Luna) are newer than model training data. Check `node_modules` `.d.ts` files and vendor docs before changing adapter code; don't rely on memory.
- Browser code lives in `src/web/client/` as TypeScript modules with its own tsconfig (DOM lib, no Bun types). `src/runtime/client-assets.ts` bundles one script per page entry (`ENTRIES`) and serves them under `/assets/` on the admin host; outside production it rebuilds per request, so edits show on reload.
- Log through `logger(scope)` from `src/core/log.ts`, not `console.*`: pass `callId` (and `err`) as fields, so the line also lands in that call's log file (`DATA_DIR/logs/call-<date>-<call id>.jsonl`).
- Every tunable goes in `config/*.yaml` with a Zod schema in `src/core/config.ts`.
- DB schema: edit `src/adapters/storage/schema.ts`, then run `bun run db:generate`. Migrations run on startup.
- Use Bun, not Node tooling (`bun test`, `bunx`, `bun:sqlite`; Bun loads `.env` automatically).
- Real-call demos at `/listen`: `demos/README.md`. Their inputs stay in `data/demos/` (they name the people redacted); only redacted files go in `demos/calls/`.
