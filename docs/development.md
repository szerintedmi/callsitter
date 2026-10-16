# Development

Commands are in the [README](../README.md#run). Setup of Telnyx, Telegram, the tunnel and OpenAI SIP: [setup.md](setup.md).

## Replay

`bun run replay <file>` runs a transcript through Jev and the call flow, with no phone call. Transcript files have `caller: …` / `agent: …` lines.

- `--fake` runs offline with a keyword classifier: `bun run replay test/fixtures/scam-bank.txt --fake`.
- Without it, real Jev (`TYPESAFE_API_KEY`).
- `--luna` also calls real Luna (`OPENAI_API_KEY`). Tools run dry, so no call is ended.

## Evals

`bun run eval [names…]` (`evals/`, not part of `bun test`): one case in `evals/cases.yaml` per fragile point found on test calls, against the real vendors and the real `config/`. They follow the single-turn approach of OpenAI's [GPT-Live evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation), which also says to run each scenario several times, since voice models are nondeterministic.

- `jev`: a short transcript through real Jev and the call flow; `? …` lines check Jev's answers, the stage and the rule after a caller line.
- `live`: the conversation so far goes to gpt-live-1 as text history, the stage texts are appended, and the caller's turn is spoken with TTS (cached in `evals/.cache`). A judge model grades the reply, and the result gives the agent's reply latency and its longest pause mid-reply.
- `luna`: Luna's rolling update for the owner (`run: progress`), graded by the judge.
- Options: `--kind jev|live|luna`, `--runs 3` for borderline results, `-v` to print every reply, `--config <dir>` to try a changed copy of `config/`, `--check` to validate the cases only.
- Results go to `evals/.out/<time>.json`, each live run's audio to `evals/.out/<time>/<case>-<run>.wav` (left: the caller's spoken turn, right: the agent).
- About a minute (live cases run in real time). Run it after changing a prompt or `jev.yaml`; add a case when a test call shows a new failure.

## Test calls

`/test-call` on the admin host (linked from the call list). Both routes use the real Live, Jev and Luna, and get a Telegram status message, so you can try steering. Luna's tools run dry by default: she can't hang up. Use headphones, or the agent hears itself.

- **Browser**: the mic's 16 kHz PCM16 goes over a WebSocket, both ways; the server runs a normal call session with only the phone leg replaced (`src/web/test-call.ts`). Recorded as a stereo WAV: mic left, the audio Live sent right, at arrival time. Listed with the caller `browser`.
- **SIP**: the call reaches OpenAI over SIP, as a real call does. A Telnyx WebRTC client can't dial a SIP URI (`404 Invalid destination number D11`), so the page dials `callsittertest<nonce>` on the credential connection, which parks it; `/telnyx/webhook` then `transfer`s it to `sip:<project>@sip.api.openai.com` (TLS, SRTP) with the nonce in `X-CallSitter-Test`. Listed as `browser (SIP)`. The page's **Debug log** shows the Telnyx call states and the server's log lines.

## Call page

A live status strip, and a timeline with one row per utterance: transcript | Jev | Luna, call-flow stages, tools and errors. The admin UI also has the call list (filters by channel and verdict) and page analytics (`/analytics`).

## Layout

```
src/core/        runtime-agnostic: config schema, call flow, orchestrator, call session, ports
src/adapters/    telnyx, openai-live (WebSocket, SIP, WebRTC + sideband), jev, luna, telegram, storage (sqlite/fs), config
src/web/         Hono routes: webhooks, media, the public site; the admin UI on ADMIN_HOST
src/web/client/  browser TypeScript, bundled per page and served as /assets/<page>.js
src/runtime/     bun.ts entrypoint, env schema, client build
src/replay/      transcript replay + offline keyword classifier
scripts/         replay, check-config, SIP setup, prod data copies, deploy control
evals/           on-demand evals against the real vendors
demos/           the real-call recordings on the public page (demos/README.md)
deploy/          Compose file, VPS scripts, dev tunnel template (deploy.md)
```

## Config

One job per file. Schemas and cross-file checks are in `src/core/config.ts`; `bun run check-config` validates them, and edits hot-reload in dev.

| File              | What it is                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `live.yaml`       | The voice agent at the start of every call: model, voice, greeting, system prompt.                                                          |
| `jev.yaml`        | Everything Jev sees: context and every question with its answer labels.                                                                     |
| `call-flow.yaml`  | When Jev runs, ordered rules over its answers, how and when texts reach Live, the silence watchdog, Live's requests for help. Its header documents the rule format. |
| `luna.yaml`       | Luna: model, tools, limits, prompts.                                                                                                        |
| `connection.yaml` | How the audio reaches the agent: OpenAI SIP, Telnyx media stream, speech levels.                                                            |
| `cost.yaml`       | Prices: Live per minute, Luna and Jev per token.                                                                                            |
| `limits.yaml`     | Per channel (phone, test, public): spend, calls a day, at once, per caller a day, call length. Null: no limit.                             |
| `telegram.yaml`   | The owner's Telegram: the status message, steering, the public group's limits.                                                             |
| `public.yaml`     | The public page: open or closed, Luna's tools, the greeting wait, sign-ups per IP.                                                          |
| `games.yaml`      | The games: goals, the referee, leaderboard size.                                                                                            |
| `analytics.yaml`  | The public pages' first-party analytics.                                                                                                    |
| `logging.yaml`    | Log files (`DATA_DIR/logs`, JSON Lines): how many days they're kept.                                                                        |

Any config text can use `{owner_name}` (`OWNER_NAME`, or "the owner") and `{agent_languages}` (`AGENT_LANGUAGES`, or "any common language"), filled in when the config loads; other placeholders are rejected.

To add a behaviour, add a Choice question to `jev.yaml` and a rule that uses it to `call-flow.yaml`; the loader rejects rules that name unknown questions or answers.

### What reaches Live, and when

- **Call start:** the `live.yaml` prompt and the greeting.
- **Each caller pause:** Jev answers the `jev.yaml` questions and the first matching `call-flow.yaml` rule runs: it sends Live a text, or hangs up after the goodbye. Texts wait until the agent is idle, unless the rule says to send at once.
- **Live asks for help:** a fixed, neutral answer at once ("Nothing new.", `call-flow.yaml → when_live_asks_for_help`).
- **Silence:** the agent is nudged; after the goodbyes, or repeated silence, the call ends.
- **Time up:** 30 s before `max_call_seconds` (a channel's `limits.yaml` can cap it lower) the agent is told to say goodbye and the call enters `time_up`. At the limit the call ends once the goodbye has played.
- **Your Telegram message:** at once, as commentary, instructions or thinking. A stage text due within `steering.hold_stage_ms` waits, so it doesn't replace what you said.
- **Hangup:** nothing more reaches Live; Luna writes the summary for the call's status message.
