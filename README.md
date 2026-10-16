# ScamSitter

An AI that answers my phone. Scammers get their time wasted, sales calls get a polite no, and real callers get their message taken.

## Hear it on real calls

| [![Are you AI?](demos/posters/areyouai.jpg)](https://callsitter.org/listen/areyouai) | [![The police](demos/posters/police-scam.jpg)](https://callsitter.org/listen/police-scam) | [![Bot vs bot](demos/posters/crypto-bot.jpg)](https://callsitter.org/listen/crypto-bot) | [![The electrician](demos/posters/electrician.jpg)](https://callsitter.org/listen/electrician) |
| :-: | :-: | :-: | :-: |
| **Are you AI?** (¾ min + the song) | **The police** (13 min) | **Bot vs bot** (4 min) | **The electrician** (1½ min) |

## Try it

<a href="https://callsitter.org/play"><img src="demos/posters/play.gif" alt="Scam me: tap to play" width="280"></a>

Try to scam the bot, or get a message through to me, from your browser: [callsitter.org/play](https://callsitter.org/play).

## How it works

Calls to my number divert to a Telnyx number, where an OpenAI **gpt-live-1** agent answers. **TypeSafe Jev** classifies the growing transcript, and a deterministic call flow (`config/call-flow.yaml`) steers the agent:

- **Scam** (Jev ≥ 0.85): waste their time, mixing a few tactics.
- **Sales call** (spam, Jev ≥ 0.85): decline politely, ask to be taken off the list, say goodbye.
- **Genuine caller:** take a message; it reaches me in the call summary.
- **Urgent** (urgency ≥ 0.85 while scam + spam is under 0.5, or Luna says I may want to act while the caller is on the line): a notifying 🚨 reply on Telegram, once per call (`telegram.yaml → status.urgent_alert`). It doesn't steer the call.

**GPT-6 Luna** writes for me, not the caller: the rolling summary, open questions and suggested replies, and the end-of-call summary. She doesn't steer the agent mid-call.

**Telegram** (`telegram.yaml`): one status message per call, edited as it goes with the verdict, the stage, Luna's summary and open questions, and the transcript (newest first, collapsed). Jev decides when the summary is out of date (`jev.yaml → owner_update`, ≥ 0.8), with a refresh every 30 s anyway while the caller talks (`luna.yaml → progress`). When the call ends, Luna's summary, the cost and a link to the call page replace it.

**Steering from Telegram:** reply to a status message, or send one while a call is live, and it reaches the agent as a `SUPERVISOR:` line: plain text as commentary, `!` for instructions (cuts the agent off), `~` for thinking. The **Genuine**, **Scam** and **Spam** buttons move the call into that stage (`genuine`, `waste_time`, `decline_spam`) as if Jev had decided; **Hang up** (or `/hangup`) has the agent say goodbye, then ends the call. A message alone can't end a call. Up to 3 replies Luna suggests go as commentary (`telegram.yaml → steering.suggestions`). The automatic flow keeps running, but a stage text it sends within 30 s of your message or button waits until then, so it doesn't replace what you said (`steering.hold_stage_ms`). Your messages show on the call page as "owner → Live".

**Costs** come from what the vendors report: Live per second, Luna's tokens (uncached, cached, cache writes, output, times the service tier) and Jev's input tokens (`cost.yaml`). Each call stores the breakdown; the call list, the call page and the final Telegram update show it.

**Limits** (`limits.yaml`, `src/core/limits.ts`), per channel (the phone number, admin test calls, the public page): spend, calls a day, calls at once, calls per caller a day and call length, counted over a rolling 24 h from the call list. Once the last 24 h's phone calls have cost $20, the next caller hears busy (SIP 486) before anything billed starts, and I get one Telegram line about it; the call that crosses the cap runs to its end.

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
- `--luna` also calls real Luna (`OPENAI_API_KEY`). Tools run dry, so no call is ended.
- Transcript files use lines of the form `caller: …` / `agent: …`.

**Evals** (`evals/`, on demand, not part of `bun test`): a small set of cases in `evals/cases.yaml`, one per fragile point found on test calls, run against the real vendors and the real `config/`. They follow the single-turn approach of OpenAI's [GPT-Live evaluation guide](https://developers.openai.com/cookbook/examples/audio/voice_agent_evaluation), which also says to run each scenario several times, since voice models are nondeterministic.

- `jev`: a short transcript through real Jev and the call flow. `? …` lines check Jev's answers, stage and rule after a caller line.
- `live`: the conversation so far is sent to gpt-live-1 as text history, the call-flow stage texts are appended, and the caller's turn is spoken with TTS (cached in `evals/.cache`). A judge model grades the reply.
- `luna`: Luna's rolling update for the owner on a transcript (`run: progress`), graded by the judge.
- Options: `--kind jev|live|luna`, `--runs 3` for borderline results, `-v` to print every reply, `--config <dir>` to try a changed copy of `config/`, `--check` to validate the cases only. Results are written to `evals/.out/<time>.json`, and each live run's audio to `evals/.out/<time>/<case>-<run>.wav` (stereo, left: the caller's spoken turn, right: the agent; earlier history is text, so it isn't in the recording). A live result also gives how long after the caller stopped the agent replied, and its longest pause mid-reply.
- It takes about a minute, since live cases run in real time. Run it after changing a prompt or `jev.yaml`, and add a case when a test call shows a new failure.

**Test call from the browser** (`/test-call`, linked from the call list): talk to the voice agent through the computer mic, with no phone or Telnyx involved.

- The page streams 16 kHz PCM16 over a WebSocket as binary frames, in both directions. The server runs a normal call session on it (Live, Jev, call flow, Luna); only the phone leg is replaced (`src/web/test-call.ts`).
- It uses the real Live, Jev and Luna APIs. Luna's tools run dry by default: she can't hang up. The call still gets its Telegram status message, so you can try steering from it.
- Use headphones, or the agent hears itself.
- Test calls appear in the call list with the caller shown as `browser`.

**SIP test call** (same page, route "SIP"): the call reaches OpenAI over SIP, the way a real call arrives with OpenAI SIP.

- A Telnyx WebRTC client can't dial an external SIP URI: Telnyx answers `404 Invalid destination number D11`. So the page dials `scamsittertest<nonce>` on a credential connection that parks calls. `/telnyx/webhook` then `transfer`s the parked call to `sip:<project>@sip.api.openai.com` with TLS and SRTP, forwarding the nonce in `X-ScamSitter-Test`.
- It needs the setup in [OpenAI SIP](#openai-sip). Test calls show up as `browser (SIP)`.
- The page's **Debug log** shows the Telnyx call states (with SIP codes) and the server's log lines.

**Public site** (`https://<public host>/`, the host Telnyx calls; preview at `/public` on the admin host): the real call recordings at `/` (`src/web/listen.ts`; `/listen/<slug>` opens one, playing), a "Get your own bot" waitlist at `/bot` (`POST /call/waitlist`), and at `/play` an arcade game-select screen with two games for anyone with the link (`config/games.yaml`, scoring in `src/core/game.ts`). The pages send first-party page analytics (no cookies) in batches to `POST /call/e` (`src/web/analytics.tsx`, `config/analytics.yaml`): views, clicks, plays and how long each recording was heard, with the visitor's IP, user agent and location; the admin UI shows them at `/analytics`.

- **Scam me**: the visitor plays a scammer with a goal (safe account, police, crypto wallet…). The scam starts when they say they're who the goal says (e.g. "Peter from HMRC"); from then until they hang up they score 10 points a second, double before the call flow catches them (`waste_time` stage; `scam.undetected_multiplier`). Most points wins. Chatting before the start doesn't count, and points keep coming once caught, so it pays to stay while the agent wastes *their* time.
- **Get through**: the visitor plays a real caller with a reason to call. Score: time until they've passed on the message, unless caught first; fastest wins.
- **The referee** (`src/core/referee.ts`, `games.yaml → referee`) decides "started the scam" and "passed on the message": a separate Jev call with the goal's `start` or `message`, run as each caller line's final transcript arrives until it's met, and once more at hang-up. Only the referee knows the goal: the call's own Jev, Live and Luna judge the call like any other.
- Scores are settled on the server and stored with the call (`plays` table) under the visitor's 3-letter name (kept in the browser). Each goal has its own leaderboard of its top scores; a player can hold several places.
- **Scammer time wasted** (on both pages) adds up calls judged scam or spam (public ones too), full length; on the game page it ticks up while one is live.

- The browser talks to gpt-live-1 over **WebRTC**. The server exchanges the SDP offer with `POST /v1/live/sessions` ([voice-webrtc](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live): "we recommend using WebRTC rather than WebSockets for more consistent performance") and attaches a sideband, as for a SIP call. The API key and the prompt stay on the server.
- The page's data channel is locked down (`client.data_channel`): it can't send any client event, so a visitor can't append instructions. It only receives `session.closed`.
- Cost caps (`config/limits.yaml → public`): a 10-minute call length, 3 calls at once, 20 calls per IP a day, 100 public calls a day and $10 a day, all counted from the call list over a rolling 24 h, so a restart doesn't reset them. The spend is the ended calls' stored cost: new calls are refused once it reaches the cap, and the call that crosses it runs to its end.
- Once the day's calls or budget have run out (or the page is closed), the page says it has run out of game and offers a "notify me" form (`POST /call/notify`, 5 sign-ups per IP a day). The emails go in the `notify_signups` table (`list` = `notify`), with the visitor's IP, country and what had run out; the `/bot` waitlist's go in the same table with `list` = `waitlist` (the same per-IP limit); reading them: `docs/deploy.md`.
- During the call the page shows a meter that leans from genuine to scam/spam (P(scam) + P(spam) − P(genuine); an unclear verdict pulls it to the middle), the goal, and when the call was caught or got through, streamed as server-sent events from `/call/:id/events`. The score, rank and leaderboard come from `/call/:id/result` once the call has ended.
- Luna's tools are live (`public.yaml → tools`). The call gets a Telegram status message like any other (in `TELEGRAM_PUBLIC_CHAT_ID`'s group, if set), and the owner can steer it. The spend counts the rolling summaries too. Calls are recorded and listed in the `public` channel, with the caller `public` and the visitor's IP (`CF-Connecting-IP`, stored with the call).
- Why the admin test call uses a WebSocket relay instead: it exercises the Telnyx media-stream path that real calls take. The public page is the only caller that really arrives over WebRTC.

**Call page:** a live status strip, and an aligned timeline with one row per utterance: transcript | Jev classifications | Luna, call-flow stages, tools and errors.

## Setup

1. **Telnyx**
   - Create a Call Control application with webhook URL `https://hooks.<domain>/telnyx/webhook` and assign your UK number to it.
   - Copy the webhook public key into `TELNYX_PUBLIC_KEY`.
2. **Telegram** (optional; without it there are no status messages, rolling summaries or steering)
   - Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `TELEGRAM_BOT_TOKEN`.
   - Send the bot any message from the owner's account, then read `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates` into `TELEGRAM_CHAT_ID`. A bot can't message someone who hasn't started a chat with it.
   - The app receives your messages by long polling (`getUpdates`), so no public URL is needed. Only one process can poll a bot at a time, so give dev its own bot. Steering needs a numeric chat id, and only that chat is heard.
   - Optional: public-page calls can go to a chat of their own, a group, with `TELEGRAM_PUBLIC_CHAT_ID` (phone and test calls stay in `TELEGRAM_CHAT_ID`; blank, everything goes there). Add the same bot to the group, send a message there, and read the negative `message.chat.id` from `getUpdates`. If Telegram upgrades the group to a supergroup, its id changes (to `-100…`): update the variable. The group gets fewer edits and no urgent alerts (`telegram.yaml → public`), since a group allows about 20 messages a minute.
   - In a group, replies to the bot's messages and its buttons work as they are. For a plain message to steer the newest public call (or a bare `/hangup`), turn the bot's privacy mode off (@BotFather → `/setprivacy` → Disable, then remove and re-add the bot), or make it an admin of the group; otherwise the bot only hears replies to it and `/hangup@<botname>`.
   - Send `/help` to the bot for how steering works.
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
- Hangups go to `POST /v1/live/sessions/{id}/hangup`. When Live ends the session itself (`session.closed`: the caller hung up shows as `remote_hangup` or `connection_lost`), the call just ends: a hangup for a closed session stalls for over 5 s. Settings are in `connection.yaml → sip`; the `media_stream` settings don't apply.
- Live keeps running through silence on its own (no filler audio needed), and the silence watchdog listens to the sideband's reflected caller audio. Each call's log file has the speech segments the watchdog heard and any gaps in that audio (`src/core/speech-trace.ts`); the timeline gets a one-line summary.

Setup:

1. Run `bun scripts/setup-sip.ts` (with `--dry-run` first). It creates:
   - the OpenAI webhook;
   - a Telnyx credential connection that parks calls and sends webhooks to `/telnyx/webhook`;
   - a telephony credential for the browser test.

    It writes `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, `TELNYX_SIP_CONNECTION_ID` and `TELNYX_SIP_CREDENTIAL_ID` to `.env`. Restart the server afterwards: `--watch` doesn't reload `.env`.
2. Add `openai/webhook` to the public path regex in `deploy/cloudflared.yml`, then restart the tunnel.
3. For real calls, run `bun scripts/direct-sip.ts on` (`status`, `off`, `--dry-run`). It follows [Telnyx's GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide):
   - an FQDN connection to `sip.api.openai.com:5061` with TLS, SRTP mandatory, G.711 A-law/µ-law, and media anchored in London;
   - the number on it, with "Translated Number" set to the project ID, and Telnyx's own dual-channel recording on;
   - the OpenAI webhook pointed at `PUBLIC_WS_BASE`'s host (from the laptop, `PUBLIC_WS_BASE=wss://<production host> bun scripts/direct-sip.ts on` points it at production).

   This takes the number off the Call Control app, so the media-stream path no longer receives its calls. `off` puts back what `on` saved in `DATA_DIR/direct-sip-restore.json`.

## Layout

```
src/core/       runtime-agnostic: config schema, call flow, orchestrator, call session, ports
src/adapters/   telnyx (webhooks/REST/media), openai-live (WebSocket, SIP, WebRTC + sideband), jev, luna, storage (sqlite/fs), config (yaml)
src/web/        Hono routes: /telnyx/webhook, /openai/webhook, /media/:callId/:codec/:token, the public page (/, /call…); admin UI on ADMIN_HOST
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
| `cost.yaml`       | Prices for each call's cost: Live per minute, Luna and Jev per token.                                                                                                                                       |
| `public.yaml`     | The public page's settings: open or closed, Luna's tools, the greeting wait, email sign-ups per IP.                                                                                                         |
| `limits.yaml`     | Call limits per channel (phone, test, public): spend, calls a day, calls at once, calls per caller a day, call length. Left out or null: no limit.                                                          |
| `games.yaml`      | The public page's games: goals for Scam me and Get through, the referee that judges them, leaderboard size.                                                                                                  |
| `telegram.yaml`   | The owner's Telegram: the per-call status message, how steering messages reach Live, and the public-calls group's limits. |
| `logging.yaml`    | The server's log files (`DATA_DIR/logs`, JSON Lines): how many days they're kept.                                                                                                                            |


What reaches Live, and when:

- **Call start:** the `live.yaml` prompt and the greeting.
- **Each caller pause:** Jev answers the `jev.yaml` questions, and the first matching `call-flow.yaml` rule runs. It sends Live a text, or hangs up after the goodbye (a rule can also ask Luna, `ask_luna`; none does now). Texts wait until the agent is idle, unless the rule says to send at once.
- **Live asks for help:** a fixed, neutral text answers at once ("Nothing new.", `call-flow.yaml → when_live_asks_for_help`), so it doesn't replace your Telegram message; with `{luna_response}` in it, Luna would answer.
- **Silence:** the agent is nudged; after the goodbyes, or repeated silence, the call ends.
- **Time up:** 30 s before `max_call_seconds` (`call-flow.yaml → timing.time_up`; a channel's `limits.yaml → max_call_seconds` can cap it lower), the agent is told to say goodbye and the call enters `time_up`, where no rule sends anything. At the limit, the call ends once the goodbye has played, or at the first silence after it.
- **Your Telegram message:** sent at once, as commentary, instructions or thinking (`telegram.yaml → steering`). Luna guidance from a run that started before it is dropped, and a call-flow stage text due within `hold_stage_ms` waits (not time-up).
- **Hangup:** nothing more reaches Live; Luna writes the summary, which goes into the call's Telegram status message.

Any config text can use `{owner_name}` (`OWNER_NAME` from `.env`, or "the owner" if unset) and `{agent_languages}` (`AGENT_LANGUAGES`, or "any common language"); it is filled in when the config loads, and other placeholders are rejected.

To add a behaviour, add a Choice question to `jev.yaml` and a rule that uses it to `call-flow.yaml`; the loader rejects rules that name unknown questions or answers.

## How it maps to the vendor APIs

These differ from the original plan:

- **Live transcripts have no item ids and no "done" events.** `session.input_transcript.delta` and `session.output_transcript.delta` carry only `start_ms`/`end_ms`. The docs say: "these events do not define complete turns or include a transcript-done event" (`openai/resources/live/live.d.ts`). `adapters/openai-live/segmenter.ts` groups deltas into utterances by speaker, timeline gap and idle time.
- **Live sends no interruption event.** The model handles interruptions itself (full duplex; prompt: "Stop speaking when the user interrupts"), so agent audio is passed straight through. There's no local barge-in or playback gating. Audio Live has already sent still plays out after an interruption (up to about a second, per [live-migration](https://developers.openai.com/api/docs/guides/live-migration)). Telnyx noise suppression (`suppression_start`, direction `outbound`) can clean the caller's audio: `connection.yaml → media_stream.noise_suppression`.
- **Jev runs on caller pauses, not a timer.** It classifies once the caller pauses, and periodically during long monologues (`call-flow.yaml → timing.classify`). One call runs at a time; words that arrive during it trigger the next. Agent speech never triggers Jev, but Jev sees the whole transcript, both sides.
- **Live streams output audio continuously**, in real time, and pads pauses with silence or faint noise (measured). So "agent audio arrived" doesn't mean "agent is talking": the silence watchdog and the agent-idle check go by speech level (`connection.yaml → speech_detection`).
- **Live has no idle behaviour.** It waits quietly when nobody speaks, and it only advances while input audio keeps arriving ("Keep input audio running throughout…, including silence", [live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). A silence watchdog nudges the agent, and ends the call after repeated silence or after the goodbyes (`call-flow.yaml → silence`).
- **How an append lands depends on its kind** (measured on gpt-live-1, 2026-09-25; details in the `call-flow.yaml` header). `instructions` cuts off what the agent is saying or about to say, and sent to an idle agent it mostly waits for the caller's next turn. `commentary` makes the agent act and speak at once, in its own words, without cutting it off. `thinking` shapes later replies, and kept the time-wasting role as well as commentary did. The docs only say an instruction "can interrupt the model's current speech or behavior", and that an append is acknowledged "without guaranteeing that the model has acted on them" ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)). So texts go out once the agent is idle: roles as `thinking`, things to say now as `commentary`, and `resist_manipulation` (jailbreak attempts) goes out at once as `commentary`: as `instructions` it cut the agent off mid-sentence and it went quiet. Luna's reply goes out as a `SUPERVISOR:` line, which the Live prompt says overrides the agent's own plan.
- **The Live prompt only handles an unclear call.** How to handle a genuine, scam or spam call is in that stage's text in `call-flow.yaml`, sent once the call flow (or the owner's button) decides. Evals (2026-09-29, 3 runs each) passed as well as or better than with every kind in the prompt, and better on unclear calls. In scam mode the agent pauses mid-reply for over 2.5 s, so live evals wait 6 s (the silence watchdog) before taking its reply as finished. The scam text stays `thinking`: as `commentary`, the jailbreak case failed 2 of 5 runs. The Live prompt also says nobody can look anything up for it, so it answers what it doesn't know itself: told to delegate "only for what its instructions don't cover", it still asked for help up to 12 times in a prod scam call (2026-10-12), each time the caller asked something it couldn't know. - **Luna is off the call.** She judged each call herself and kept her own copy of how to handle each kind, so her steps contradicted the stage texts (a goodbye before "anything else?", the owner in the third person), and each of Live's requests for help cost a 3–7 s "just a moment" pause. She has no information Live lacks (no diary, no tools but `end_call`), and the Live prompt now handles unclear calls itself. So `call-flow.yaml` is the one source of what Live is told: the `low_confidence` rule (Jev unsure → Luna) is gone, and Live's requests for help get a fixed answer. Her rolling updates and summary see the call-flow stage, so they match how the call is being handled. The machinery stays: an `ask_luna` rule plus `luna.yaml → instructions` brings her back, and config loading refuses the rule without the instructions.
- **No WebSocket compression to Live.** Bun's client offers `permessage-deflate` by default, which compresses every 20 ms audio frame, so the adapter turns it off.
- **The call flow never tells Jev the current stage.** Jev answers every question on every tick, and a time-wasting stage in its state would hint "scam" to the verdict question.
- **Browser test calls are recorded** as a stereo WAV: mic on the left, the audio Live actually sent on the right, placed at arrival time. If a word is missing on the right, Live never produced it.
- **Live has no response trigger for the greeting.** Following [live-prompting](https://developers.openai.com/api/docs/guides/live-prompting), a `session.instructions.append` after `session.started` tells the agent to say the greeting first.
- **Live compacts long conversations.** Past 90% of its 128k context it swaps in a replacement engine that gets the startup instructions plus ≤ 8,192 tokens of recent history and a summary; appended texts aren't documented to survive ([live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). Every `session.usage.updated` is stored as a `live.usage` event. The timeline shows the context share next to each steering entry, and a drop in it is logged as a warning.
- **Delegation events carry only an id.** `session.delegation.created` has no task text, so when Luna answers one she gets the transcript, and her answer goes back with that `delegation_id` ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)).
- **Luna keeps one conversation per call** when she steers it. Each run continues the previous one with `previous_response_id`, so she sees her earlier guidance and tool results. Every run still sends the full transcript and her instructions, which a chain doesn't carry ([conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)). Runs are serialized so the chain can't fork, and the end-of-call summary continues it.
- **The greeting is a recording of Live itself.** Asked to greet, Live takes a few seconds to connect and speak. So `src/core/greeting.ts` records Live saying the greeting in the background, and calls play it the moment media connects while Live connects in parallel and continues from it.
- **Luna may finish after hangup.** A running Luna call gets up to `luna.drain_timeout_ms` to complete (she can still message the owner); her guidance is dropped. `call.ended` and the summary wait for it.
- **The SDK's `LiveWS` requires the `ws` package.** The adapter uses Bun's built-in `WebSocket` with an auth header, and only the SDK *types*.
- **Jev Noul answers have no confidence** (docs.typesafe.ai/confidence). The verdict is therefore a Choice (scam/spam/genuine/unclear). Confidence is the probability mass of the chosen family: for a scam or spam verdict it is P(scam)+P(spam), for genuine it is P(genuine). Urgency is a Score question normalised to 0..1.
- **Telnyx `answer` has no bidirectional sampling-rate option.** It exists only on `dial` and `streaming_start`, so `l16` answers first and then calls `streaming_start` at 16 kHz.
- **Outbound RTP chunks must be 20 ms – 30 s.** `TelnyxMediaChannel` re-frames Live audio into ≥20 ms frames and pads the tail with silence.

## Still to verify on a real call (spike)

- OpenAI SIP:
  - Verified on 2026-09-24: Telnyx Call Control → `sip:<project>@sip.api.openai.com` with TLS and SRTP reaches OpenAI. The webhook, accept, sideband, greeting, recording and hangup all worked.
  - Verified on 2026-09-27 with the number on an FQDN connection (8 calls from a UK mobile): no gaps in the sideband's caller audio; on the three checked, the watchdog heard the same speech as Telnyx's recording; silence prompts and the silent-line hangup worked. Turn gaps in Telnyx's recording (caller stops → agent starts): median 2.10 s over the media stream, 1.78–1.86 s over SIP. Telnyx ↔ OpenAI took 640–740 ms per turn with the default anchor, 520–580 ms anchored in London.
  - `sip-eu.api.openai.com` refuses our project: "401 This endpoint is only accessible by projects with geography restrictions enabled" (an EU data-residency project).
  - Whether Telnyx passes the `X-ScamSitter-Test` header from a `transfer` through to OpenAI.
  - Which From/To/Diversion headers arrive. They're logged on every SIP call.
  - Whether the sideband gets `session.started` on attach. The adapter treats an open socket as ready.
- Interruptions: how much already-sent agent audio still plays after the caller cuts in, and whether that's acceptable.
- Noise suppression: `suppression_start` is accepted (BETA), and it applies before the media fork.
- Whether the default `stream_bidirectional_target_legs` (`opposite`) plays audio to the caller on an answered inbound call. It is left at the Telnyx default.
- L16: Telnyx byte order (assumed big-endian and swapped), and whether the inbound stream is also 16 kHz after `streaming_start`.
- The transcript segmenter's gap and idle defaults against real Live transcript timing.
- Jev latency from the UK, and whether the verdict probabilities are well calibrated for the `call-flow.yaml` thresholds.

