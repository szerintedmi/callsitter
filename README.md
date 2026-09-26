# ScamSitter

An AI call screener for a personal phone number. Divert your calls to a Telnyx number, and an OpenAI **gpt-live-1** agent answers them. **TypeSafe Jev** classifies the growing transcript, and a deterministic call flow (`config/call-flow.yaml`) steers the agent:

- **Scam or spam:** it tells the voice agent to waste their time, mixing a few tactics.
- **Genuine caller:** the agent takes a message itself; after the call **GPT-6 Luna** saves it.
- **The classifier is unsure, or the agent asks for help:** Luna judges and returns guidance, and can call tools such as an urgent Telegram message to the owner.
- **After every call** where the caller spoke, Luna's summary goes to the owner on Telegram with a link to the call page (`luna.yaml → summary_to_owner`).

## Run

```sh
bun install
cp .env.example .env      # fill in keys
bun run dev               # http://127.0.0.1:8787/ (admin UI), config hot-reloads
```


| Command                                   | Purpose                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `bun test`                                | unit tests, plus an end-to-end steel-thread test with faked vendors     |
| `bun run typecheck`                       | `tsc --noEmit`                                                          |
| `bun run check-config`                    | validate `config/*.yaml`                                                |
| `bun run replay <file> [--fake] [--luna]` | replay a transcript through Jev → call flow (→ Luna) with no phone call |
| `bun run eval [names…] [--runs N]`        | on-demand evals against the real vendors (see Evals below)              |


Replay examples:

- `bun run replay test/fixtures/scam-bank.txt --fake` runs offline with a keyword classifier.
- Without `--fake` it uses real Jev (`TYPESAFE_API_KEY`).
- `--luna` also calls real Luna (`OPENAI_API_KEY`). Tools run dry, so no Telegram message is sent and no call is ended.
- Transcript files use lines of the form `caller: …` / `agent: …`.

**Evals** (`evals/`, on demand, not part of `bun test`): a small set of cases in `evals/cases.yaml`, one per fragile point found on test calls, run against the real vendors and the real `config/`. They follow the single-turn approach of OpenAI's [GPT-Live evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation), which also says to run each scenario several times, since voice models are nondeterministic.

- `jev`: a short transcript through real Jev and the call flow. `? …` lines check Jev's answers, stage and rule after a caller line.
- `live`: the conversation so far is sent to gpt-live-1 as text history, the call-flow stage texts are appended, and the caller's turn is spoken with TTS (cached in `evals/.cache`). A judge model grades the reply.
- `luna`: one Luna run on a transcript, graded by the judge.
- Options: `--kind jev|live|luna`, `--runs 3` for borderline results, `-v` to print every reply, `--config <dir>` to try a changed copy of `config/`, `--check` to validate the cases only. Results are written to `evals/.out/`.
- It takes about a minute, since live cases run in real time. Run it after changing a prompt or `jev.yaml`, and add a case when a test call shows a new failure.

**Test call from the browser** (`/test-call`, linked from the call list): talk to the voice agent through the computer mic, with no phone or Telnyx involved.

- The page streams 16 kHz PCM16 over a WebSocket as binary frames, in both directions. The server runs a normal call session on it (Live, Jev, call flow, Luna); only the phone leg is replaced (`src/web/test-call.ts`).
- It uses the real Live, Jev and Luna APIs. Luna's tools run dry by default: no Telegram message is sent and Luna can't hang up.
- Use headphones, or the agent hears itself.
- Test calls appear in the call list with the caller shown as `browser`.

**SIP test call** (same page, route "SIP"): the call reaches OpenAI over SIP, the way a real call arrives with OpenAI SIP.

- A Telnyx WebRTC client can't dial an external SIP URI: Telnyx answers `404 Invalid destination number D11`. So the page dials `scamsittertest<nonce>` on a credential connection that parks calls. `/telnyx/webhook` then `transfer`s the parked call to `sip:<project>@sip.api.openai.com` with TLS and SRTP, forwarding the nonce in `X-ScamSitter-Test`.
- It needs the setup in [OpenAI SIP](#openai-sip). Test calls show up as `browser (SIP)`.
- The page's **Debug log** shows the Telnyx call states (with SIP codes) and the server's log lines.

**Public page** (`https://<public host>/`, the one Telnyx calls; preview at `/public` on the admin host): a single **Scam me** button for anyone with the link. The visitor plays the scammer.

- The browser talks to gpt-live-1 over **WebRTC**. The server exchanges the SDP offer with `POST /v1/live/sessions` ([voice-webrtc](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): "we recommend using WebRTC rather than WebSockets for more consistent performance") and attaches a sideband, as for a SIP call. The API key and the prompt stay on the server.
- The page's data channel is locked down (`client.data_channel`): it can't send any client event, so a visitor can't append instructions. It only receives `session.closed`.
- Cost caps (`config/public.yaml`): a 10-minute call length, 3 calls at once, 10 calls per IP a day, and a rolling-24 h budget. A call is admitted only if it fits even if it and every live public call run the full 10 minutes.
- During the call the page shows a meter whose needle leans from genuine to scam/spam (P(scam) + P(spam) − P(genuine); an unclear verdict pulls it to the middle) and the call-flow stage, streamed as server-sent events from `/call/:id/events`.
- Luna's tools are live (`public.yaml → tools`), and the call's summary goes to the owner on Telegram. Calls are recorded and listed with the caller `public` and the visitor's IP (`CF-Connecting-IP`, stored with the call).
- Why the admin test call uses a WebSocket relay instead: it exercises the Telnyx media-stream path that real calls take. The public page is the only caller that really arrives over WebRTC.

**Call page:** a live status strip, and an aligned timeline with one row per utterance: transcript | Jev classifications | Luna, call-flow stages, tools and errors.

## Setup

1. **Telnyx**
   - Create a Call Control application with webhook URL `https://hooks.<domain>/telnyx/webhook` and assign your UK number to it.
   - Copy the webhook public key into `TELNYX_PUBLIC_KEY`.
2. **Telegram** (optional; without it there are no call summaries on Telegram, and Luna isn't offered `send_telegram_to_owner`)
   - Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `TELEGRAM_BOT_TOKEN`.
   - Send the bot any message from the owner's account, then read `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates` into `TELEGRAM_CHAT_ID`. A bot can't message someone who hasn't started a chat with it.
3. **Cloudflare tunnel:** see [deploy/cloudflared.example.yml](deploy/cloudflared.example.yml).
   - `hooks.<domain>` is public, but only the webhook, media and public-page paths are routed.
   - `admin.<domain>` serves the admin UI (call list, call pages, test call) at its root, behind Cloudflare Access. The app verifies the Access JWT itself (`ADMIN_AUTH=access`, with `ADMIN_HOST`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`), so a direct `127.0.0.1` request gets 403.
   - The admin UI has its own hostname so it never shares a browser origin with the public host, whose root serves the public page.
   - For offline dev, set `ADMIN_AUTH=none`. The admin UI is then served on loopback only; Host and Origin are still checked.
   - Copy it to `deploy/cloudflared.yml` (gitignored, since it has machine-specific paths and IDs) and run `bun run tunnel`.
4. **Divert your mobile** to the Telnyx number (this is a phone setting).

**Production** runs on an OVH VPS in Docker, deployed by GitHub Actions on every push to `main`: see [docs/deploy.md](docs/deploy.md).

## OpenAI SIP

gpt-live-1 can answer the SIP leg itself ([voice-sip](https://developers.openai.com/api/docs/guides/voice-sip?api=live)). Telnyx sends the call to `sip:<project>@sip.api.openai.com;transport=tls` and OpenAI posts a signed `live.transport.incoming` webhook to `/openai/webhook`. The app then accepts the call with the `live.yaml` prompt and voice, and attaches a **sideband** WebSocket (`/v1/live/sessions/{id}/attach`). Everything else is the normal call session:

- Transcripts, Jev, the call flow and Luna run as usual. Steering goes out over the sideband as `session.instructions.append`, `session.thinking.append` or `session.commentary.append` (each `tell_live` says which with `as`).
- Audio doesn't pass through the app. The sideband reflects both directions ("mono PCM16LE at 24 kHz"), so the call is recorded as a stereo WAV: caller on the left, agent on the right, placed by `start_ms` (`connection.yaml → sip.record`).
- Hangups go to `POST /v1/live/sessions/{id}/hangup`. Settings are in `connection.yaml → sip`; the `media_stream` settings don't apply.

Setup:

1. Run `bun scripts/setup-sip.ts` (with `--dry-run` first). It creates:
   - the OpenAI webhook;
   - a Telnyx credential connection that parks calls and sends webhooks to `/telnyx/webhook`;
   - a telephony credential for the browser test.

    It writes `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, `TELNYX_SIP_CONNECTION_ID` and `TELNYX_SIP_CREDENTIAL_ID` to `.env`. Restart the server afterwards: `--watch` doesn't reload `.env`.
2. Add `openai/webhook` to the public path regex in `deploy/cloudflared.yml`, then restart the tunnel.
3. For real calls, follow [Telnyx's GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide):
   - Create an FQDN connection to `sip.api.openai.com:5061` with TLS, SRTP mandatory, and PCMA/PCMU.
   - Assign the number to it, with "Translated Number" set to the project ID.
   - This takes the number off the Call Control app, so the media-stream path no longer receives its calls.

## Layout

```
src/core/       runtime-agnostic: config schema, call flow, orchestrator, call session, ports
src/adapters/   telnyx (webhooks/REST/media), openai-live (WebSocket, SIP, WebRTC + sideband), jev, luna, storage (sqlite/fs), config (yaml)
src/web/        Hono routes: /telnyx/webhook, /openai/webhook, /media/:callId/:codec/:token, the public page (/, /call); admin UI on ADMIN_HOST
src/web/client/ browser TypeScript for the UI pages, compiled with Bun.build and served as /assets/<page>.js on the admin host
src/runtime/    bun.ts entrypoint, env schema, client build (client-assets.ts)
src/replay/     transcript replay harness + offline keyword classifier
evals/          on-demand evals against the real vendors (cases.yaml, bun run eval)
config/         see Config below
deploy/         Compose file (production), VPS scripts (deploy/vps), dev tunnel template; docs/deploy.md
```

## Config

Each file has one job (schemas and cross-file checks: `src/core/config.ts`; `bun run check-config` validates them, and edits hot-reload in dev).


| File              | What it is                                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live.yaml`       | The voice agent as it starts every call: model, voice, greeting, system prompt.                                                                                                                             |
| `jev.yaml`        | Everything Jev sees: context and every question with its answer labels.                                                                                                                         |
| `call-flow.yaml`  | What happens: when Jev runs, ordered rules over Jev's answers, how and when texts reach Live, the silence watchdog, and Live's own requests for help. Its header comment documents the rule format. |
| `luna.yaml`       | Everything about Luna: model, tools, limits, prompts.                                                                                                                                                       |
| `connection.yaml` | How the audio reaches the agent: OpenAI SIP, Telnyx media stream, speech levels.                                                                                                                            |
| `cost.yaml`       | Rough per-call cost estimate.                                                                                                                                                                               |
| `public.yaml`     | The public page's limits: call length, calls at once, per IP, daily budget.                                                                                                                                 |


What reaches Live, and when:

- **Call start:** the `live.yaml` prompt and the greeting.
- **Each caller pause:** Jev answers the `jev.yaml` questions, and the first matching `call-flow.yaml` rule runs. It sends Live a text, asks Luna (her reply goes out the same way), or hangs up after the goodbye. Texts wait until the agent is idle, unless the rule says to send at once.
- **Live asks for help:** Luna answers, or a fallback does.
- **Silence:** the agent is nudged; after the goodbyes, or repeated silence, the call ends.
- **Time up:** 30 s before `max_call_seconds` (`call-flow.yaml → timing.time_up`), the agent is told to say goodbye and the call enters `time_up`, where no rule sends anything. At the limit, the call ends once the goodbye has played, or at the first silence after it.
- **Hangup:** nothing more reaches Live; Luna saves the caller's message and writes the summary, which goes to the owner on Telegram.

Any config text can use `{owner_name}` (`OWNER_NAME` from `.env`, or "the owner" if unset) and `{agent_languages}` (`AGENT_LANGUAGES`, or "English"); it is filled in when the config loads, and other placeholders are rejected.

To add a behaviour, add a Choice question to `jev.yaml` and a rule that uses it to `call-flow.yaml`; the loader rejects rules that name unknown questions or answers.

## How it maps to the vendor APIs

These differ from the original plan:

- **Live transcripts have no item ids and no "done" events.** `session.input_transcript.delta` and `session.output_transcript.delta` carry only `start_ms`/`end_ms`. The docs say: "these events do not define complete turns or include a transcript-done event" (`openai/resources/live/live.d.ts`). `adapters/openai-live/segmenter.ts` groups deltas into utterances by speaker, timeline gap and idle time.
- **Live sends no interruption event.** The model handles interruptions itself (full duplex; prompt: "Stop speaking when the user interrupts"), so agent audio is passed straight through. There's no local barge-in or playback gating. Audio Live has already sent still plays out after an interruption (up to about a second, per [live-migration](https://developers.openai.com/api/docs/guides/live-migration)). Telnyx noise suppression (`suppression_start`, direction `outbound`) can clean the caller's audio: `connection.yaml → media_stream.noise_suppression`.
- **Jev runs on caller pauses, not a timer.** It classifies once the caller pauses, and periodically during long monologues (`call-flow.yaml → timing.classify`). One call runs at a time; words that arrive during it trigger the next. Agent speech never triggers Jev, but Jev sees the whole transcript, both sides.
- **Live streams output audio continuously**, in real time, and pads pauses with silence or faint noise (measured). So "agent audio arrived" doesn't mean "agent is talking": the silence watchdog and the agent-idle check go by speech level (`connection.yaml → speech_detection`).
- **Live has no idle behaviour.** It waits quietly when nobody speaks, and it only advances while input audio keeps arriving ("Keep input audio running throughout…, including silence", [live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). A silence watchdog nudges the agent, and ends the call after repeated silence or after the goodbyes (`call-flow.yaml → silence`).
- **How an append lands depends on its kind** (measured on gpt-live-1, 2026-09-25; details in the `call-flow.yaml` header). `instructions` cuts off what the agent is saying or about to say, and sent to an idle agent it mostly waits for the caller's next turn. `commentary` makes the agent act and speak at once, in its own words, without cutting it off. `thinking` shapes later replies, and kept the time-wasting role as well as commentary did. The docs only say an instruction "can interrupt the model's current speech or behavior", and that an append is acknowledged "without guaranteeing that the model has acted on them" ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)). So texts go out once the agent is idle: roles as `thinking`, things to say now as `commentary`, and `resist_manipulation` (jailbreak attempts) goes out at once as `commentary`: as `instructions` it cut the agent off mid-sentence and it went quiet. Luna's reply goes out as a `SUPERVISOR:` line, which the Live prompt says overrides the agent's own plan.
- **No WebSocket compression to Live.** Bun's client offers `permessage-deflate` by default, which compresses every 20 ms audio frame, so the adapter turns it off.
- **The call flow never tells Jev the current stage.** Jev answers every question on every tick, and a time-wasting stage in its state would hint "scam" to the verdict question.
- **Browser test calls are recorded** as a stereo WAV: mic on the left, the audio Live actually sent on the right, placed at arrival time. If a word is missing on the right, Live never produced it.
- **Live has no response trigger for the greeting.** Following [live-prompting](https://developers.openai.com/api/docs/guides/live-prompting), a `session.instructions.append` after `session.started` tells the agent to say the greeting first.
- **Live compacts long conversations.** Past 90% of its 128k context it swaps in a replacement engine that gets the startup instructions plus ≤ 8,192 tokens of recent history and a summary; appended texts aren't documented to survive ([live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). Every `session.usage.updated` is stored as a `live.usage` event. The timeline shows the context share next to each steering entry, and a drop in it is logged as a warning.
- **Delegation events carry only an id.** `session.delegation.created` has no task text, so Luna gets the transcript, and her answer goes back with that `delegation_id` ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)).
- **Luna keeps one conversation per call.** Each run continues the previous one with `previous_response_id`, so she sees her earlier guidance and tool results. Every run still sends the full transcript and her instructions, which a chain doesn't carry ([conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)). Runs are serialized so the chain can't fork, and the end-of-call summary continues it.
- **The greeting is a recording of Live itself.** Asked to greet, Live takes a few seconds to connect and speak. So `src/core/greeting.ts` records Live saying the greeting in the background, and calls play it the moment media connects while Live connects in parallel and continues from it.
- **Luna may finish after hangup.** A running Luna call gets up to `luna.drain_timeout_ms` to complete (she can still message the owner or take a message); her guidance is dropped. `call.ended` and the summary wait for it.
- **The SDK's `LiveWS` requires the `ws` package.** The adapter uses Bun's built-in `WebSocket` with an auth header, and only the SDK *types*.
- **Jev Noul answers have no confidence** (docs.typesafe.ai/confidence). The verdict is therefore a Choice (scam/spam/genuine/unclear). Confidence is the probability mass of the chosen family: for a scam or spam verdict it is P(scam)+P(spam), for genuine it is P(genuine). Urgency is a Score question normalised to 0..1.
- **Telnyx `answer` has no bidirectional sampling-rate option.** It exists only on `dial` and `streaming_start`, so `l16` answers first and then calls `streaming_start` at 16 kHz.
- **Outbound RTP chunks must be 20 ms – 30 s.** `TelnyxMediaChannel` re-frames Live audio into ≥20 ms frames and pads the tail with silence.

## Still to verify on a real call (spike)

- OpenAI SIP:
  - Verified on 2026-09-24: Telnyx Call Control → `sip:<project>@sip.api.openai.com` with TLS and SRTP reaches OpenAI. The webhook, accept, sideband, greeting, recording and hangup all worked.
  - Whether Telnyx passes the `X-ScamSitter-Test` header from a `transfer` through to OpenAI.
  - Which From/To/Diversion headers arrive. They're logged on every SIP call.
  - Whether the sideband gets `session.started` on attach. The adapter treats an open socket as ready.
- Interruptions: how much already-sent agent audio still plays after the caller cuts in, and whether that's acceptable.
- Noise suppression: `suppression_start` is accepted (BETA), and it applies before the media fork.
- Whether the default `stream_bidirectional_target_legs` (`opposite`) plays audio to the caller on an answered inbound call. It is left at the Telnyx default.
- L16: Telnyx byte order (assumed big-endian and swapped), and whether the inbound stream is also 16 kHz after `streaming_start`.
- The transcript segmenter's gap and idle defaults against real Live transcript timing.
- Jev latency from the UK, and whether the verdict probabilities are well calibrated for the `call-flow.yaml` thresholds.
- Luna's cost per call (`cost.yaml → luna_usd_per_call` is a rough estimate).

