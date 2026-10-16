# How it maps to the vendor APIs

The vendor APIs are newer than most model training data: check the SDK's `.d.ts` files and the vendor docs before changing an adapter. What differs from the obvious design, and why:

## OpenAI Live (gpt-live-1)

- **Transcripts have no item ids and no "done" events.** `session.input_transcript.delta` / `session.output_transcript.delta` carry only `start_ms`/`end_ms` ("these events do not define complete turns or include a transcript-done event", `openai/resources/live/live.d.ts`). `adapters/openai-live/segmenter.ts` groups them into utterances by speaker, timeline gap and idle time.
- **No interruption event.** The model handles barge-in itself (full duplex), so agent audio is passed straight through, with no local gating. Audio already sent still plays out, up to about a second ([live-migration](https://developers.openai.com/api/docs/guides/live-migration)).
- **Output audio streams continuously**, padding pauses with silence or faint noise (measured), so "audio arrived" doesn't mean "agent is talking": the silence watchdog and the idle check go by speech level (`connection.yaml → speech_detection`).
- **No idle behaviour.** Live waits quietly when nobody speaks and only advances while input audio keeps arriving ([live-conversations](https://developers.openai.com/api/docs/guides/live-conversations)). The silence watchdog nudges the agent and ends the call after repeated silence or the goodbyes.
- **No response trigger for the greeting.** A `session.instructions.append` after `session.started` tells it to greet ([live-prompting](https://developers.openai.com/api/docs/guides/live-prompting)). Over the media stream the greeting is a recording of Live itself (`src/core/greeting.ts`), played the moment media connects while Live connects in parallel.
- **How an append lands depends on its kind** (measured 2026-09-25; details in the `call-flow.yaml` header). `instructions` cuts off what the agent is saying, and sent to an idle agent mostly waits for the caller's next turn. `commentary` makes it speak at once, in its own words, without cutting it off. `thinking` shapes later replies and keeps a role as well as commentary. The docs only promise an append is acknowledged "without guaranteeing that the model has acted on them" ([live-delegation](https://developers.openai.com/api/docs/guides/live-delegation)). So texts go out once the agent is idle: roles as `thinking`, things to say now as `commentary`; `resist_manipulation` goes out at once as `commentary` (as `instructions` it cut the agent off and it went quiet).
- **Long calls get compacted.** Past 90% of the 128k context, a replacement engine gets the startup instructions, ≤ 8,192 tokens of recent history and a summary; appended texts aren't documented to survive. Every `session.usage.updated` is stored (`live.usage`); the timeline shows the context share, and a drop is logged as a warning.
- **Delegation events carry only an id** (`session.delegation.created` has no task text), so an answer goes back with that `delegation_id` and its context comes from the transcript.

## The prompt, the call flow and Luna

- **The Live prompt only handles an unclear call.** How to handle a genuine, scam or spam call is that stage's text in `call-flow.yaml`, sent once the call flow (or the owner's button) decides. Evals (2026-09-29, 3 runs each) did as well or better than with every kind in the prompt. The scam text stays `thinking`: as `commentary` the jailbreak case failed 2 of 5. The prompt also says nobody can look anything up for it: told to delegate "only for what its instructions don't cover", it still asked for help 12 times in one prod scam call (2026-10-12).
- **Luna is off the call.** She judged calls herself, so her steps contradicted the stage texts, and each request for help cost a 3–7 s pause. She has nothing Live lacks, so `call-flow.yaml` is the one source of what Live is told, and Live's requests for help get a fixed answer. Her rolling updates and summary see the stage. An `ask_luna` rule plus `luna.yaml → instructions` brings her back (config loading refuses the rule without them).
- **Luna keeps one conversation per call** when she steers: each run continues the last with `previous_response_id`, and still sends the full transcript and her instructions, which a chain doesn't carry ([conversation-state](https://developers.openai.com/api/docs/guides/conversation-state)). Runs are serialized so the chain can't fork. A run still going at hangup gets `luna.drain_timeout_ms`; its guidance is dropped.
- **Jev runs on caller pauses, not a timer**, and periodically during long monologues (`call-flow.yaml → timing.classify`), one call at a time. Agent speech never triggers it, but it sees both sides.
- **Jev is never told the stage.** A time-wasting stage in its state would hint "scam" to the verdict question.
- **Jev answers have no confidence** ([docs](https://docs.typesafe.ai/confidence)), so the verdict is a Choice (scam/spam/genuine/unclear) and confidence is the probability mass of the chosen family: P(scam)+P(spam) for scam or spam, P(genuine) for genuine. Urgency is a Score normalised to 0..1.

## Telnyx media stream (the fallback path)

Real calls have gone over OpenAI SIP since 2026-09-27 ([setup.md](setup.md#openai-sip)); these apply to the media stream only.

- **`answer` has no bidirectional sampling-rate option** (only `dial` and `streaming_start` do), so an `l16` call answers first, then calls `streaming_start` at 16 kHz. The default codec is now G.711 A-law (`connection.yaml → media_stream.codec`).
- **Outbound RTP chunks must be 20 ms – 30 s.** `TelnyxMediaChannel` re-frames Live audio into ≥ 20 ms frames and pads the tail.
- **No WebSocket compression to Live.** Bun's client offers `permessage-deflate` by default, which would compress every 20 ms frame.
- **The SDK's `LiveWS` requires the `ws` package**, so the adapter uses Bun's `WebSocket` with an auth header and only the SDK's types.
- **Noise suppression** (`suppression_start`, BETA) can clean the caller's audio: `connection.yaml → media_stream.noise_suppression`, off by default.

## Verified on real calls

Checked against production calls up to 2026-10-16: 34 phone calls (7 over the media stream on 2026-09-27, 27 over OpenAI SIP since), plus test and public calls.

**OpenAI SIP**

- ✅ Telnyx Call Control → `sip:<project>@sip.api.openai.com` with TLS and SRTP reaches OpenAI; the webhook, accept, sideband, greeting, recording and hangup work (2026-09-24).
- ✅ Direct FQDN connection (2026-09-27): no gaps in the sideband's caller audio (since then, 24 of 25 phone calls had no gap ≥ 200 ms, one had a single 252 ms gap), the watchdog hears the same speech as Telnyx's recording, and silence prompts and the silent-line hangup work. Turn gap (caller stops → agent starts) in Telnyx's recording: median 2.10 s over the media stream, 1.78–1.86 s over SIP; Telnyx ↔ OpenAI 640–740 ms a turn with the default anchor, 520–580 ms anchored in London.
- ✅ `X-CallSitter-Test` survives the `transfer`: all 3 browser SIP test calls (2026-09-25 to 09-27) arrived with it and were matched as tests. Seen under its old name, `X-ScamSitter-Test`; no SIP test call since the rename.
- ✅ Headers on a phone call: `From` and `P-Asserted-Identity` carry the caller's number (UK national form, others without the `+`; `verstat=No-TN-Validation`), `To` is the project. There's **no `Diversion` or `History-Info`**, so the diverting number isn't known.
- ❌ `sip-eu.api.openai.com` refuses the project: "401 This endpoint is only accessible by projects with geography restrictions enabled" (an EU data-residency project).
- ☐ Whether the sideband gets `session.started` on attach: the adapter treats an open socket as ready, and server events aren't logged.

**Jev and the call flow**

- ✅ Jev latency from production: median 221 ms, p90 260 ms, p99 409 ms (1,707 phone-call classifications).
- ✅ Thresholds: no false positives. Every `waste_time` switch (scam ≥ 0.80) was a scam (11 calls), the spam rule (≥ 0.85) fired once, right (the cold call demo), `genuine` (≥ 0.7) fired right on 9 calls, `ended` (≥ 0.85) hung up right on 3. Misses are short calls: a "part-time job, add me on WhatsApp" scam reached spam 0.64 in 9 s.
- ☐ The transcript segmenter's gap and idle defaults: 40% of caller utterances on SIP calls start mid-sentence ("Okay, and also, um" / ", are you doing…"), so it splits too eagerly; partly the other side's backchannels ending an utterance. The raw delta timing isn't stored, so it can't be tuned from past calls yet.

**Telnyx media stream** (not used by real calls since 2026-09-27)

- ✅ The default `stream_bidirectional_target_legs` (`opposite`) plays the agent to the caller: the 7 media-stream calls were real conversations.
- ☐ Interruptions: how much already-sent agent audio still plays after the caller cuts in. Never measured.
- ☐ Noise suppression (`suppression_start`, BETA): never turned on.
- ☐ L16 byte order and the inbound rate after `streaming_start`: never used (the codec is A-law).
