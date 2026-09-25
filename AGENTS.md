# ScamSitter

AI call screener: Telnyx media stream ↔ OpenAI Live (gpt-live-1), TypeSafe Jev classification on caller pauses, a deterministic call flow (`config/call-flow.yaml` rules over Jev answers), GPT-6 Luna for guidance/tools. See README.md.

## Commands

- `bun test`: all tests, including `test/e2e.test.ts` (the steel thread with faked vendors)
- `bun run typecheck`, `bun run check-config`
- `bun run replay <transcript> --fake`: offline Jev/call-flow replay
- `bun run eval [names…] [--runs N]`: on-demand evals against the real vendors (`evals/cases.yaml`); run after prompt or Jev changes, not every time. Eval-only code stays in `evals/`, not in `src/`.

## Conventions

- `src/core/` must stay runtime-agnostic: no Bun, Node or `Buffer` APIs, only WebCrypto, fetch and timers. It targets a later Cloudflare Workers + Durable Object port. Bun-specific code goes in `src/adapters/*` and `src/runtime/`.
- Vendor APIs (Live, Jev, Luna) are newer than model training data. Check `node_modules` `.d.ts` files and vendor docs before changing adapter code; don't rely on memory.
- Browser code lives in `src/web/client/` as TypeScript modules with its own tsconfig (DOM lib, no Bun types). `src/runtime/client-assets.ts` bundles one script per page entry (`ENTRIES`) and serves them under `/assets/` on the admin host; outside production it rebuilds per request, so edits show on reload.
- Every tunable goes in `config/*.yaml` with a Zod schema in `src/core/config.ts`.
- DB schema: edit `src/adapters/storage/schema.ts`, then run `bun run db:generate`. Migrations run on startup.
- Use Bun, not Node tooling (`bun test`, `bunx`, `bun:sqlite`; Bun loads `.env` automatically).
