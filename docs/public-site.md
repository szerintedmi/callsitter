# Public site

Served on the public host, the one Telnyx calls (`https://callsitter.org/`; a preview at `/public` on the admin host).

- `/`: the real-call recordings (`src/web/listen.ts`); `/listen/<slug>` opens one, playing. Adding one: [demos/README.md](../demos/README.md).
- `/play`: an arcade game-select screen with two games (`config/games.yaml`, scoring in `src/core/game.ts`).
- `/bot`: a "Get your own bot" waitlist (`POST /call/waitlist`).
- `/terms`, `/privacy`.

**Analytics:** the pages send first-party analytics (no cookies) in batches to `POST /call/e` (`src/web/analytics.tsx`, `config/analytics.yaml`): views, clicks, plays and how long each recording was heard, with the visitor's IP, user agent and location. The admin UI shows them at `/analytics`.

**Scammer time wasted** (on every page's top bar) adds up the calls judged scam or spam, public ones too, full length; on the game page it ticks while one is live.

## The games

- **Scam me:** the visitor plays a scammer with a goal (safe account, police, crypto wallet…). The scam starts when they say they're who the goal says ("Peter from HMRC"); from then until they hang up they score 10 points a second, double before the call flow catches them (`waste_time`; `scam.undetected_multiplier`). Points keep coming once caught, so it pays to stay while the agent wastes *their* time.
- **Get through:** the visitor plays a real caller with a message. Score: the time until they've passed it on, unless caught first; fastest wins.
- **The referee** (`src/core/referee.ts`, `games.yaml → referee`) decides "started the scam" and "passed on the message": a separate Jev call with the goal's `start` or `message`, run on each final caller line until it's met, and once more at hang-up. Only the referee knows the goal: the call's own Jev, Live and Luna judge it like any other call.
- Scores are settled on the server and stored with the call (`plays`) under the visitor's 3-letter name. Each goal has its own leaderboard.
- During the call the page shows a meter from genuine to scam/spam (P(scam) + P(spam) − P(genuine); an unclear verdict pulls it to the middle), the goal, and when the call was caught or got through, streamed from `/call/:id/events`. The score and leaderboard come from `/call/:id/result` after the call.

## How a game call works

- The browser talks to gpt-live-1 over **WebRTC**: the server exchanges the SDP offer with `POST /v1/live/sessions` and attaches a sideband, as for a SIP call ([voice-webrtc](https://developers.openai.com/api/docs/guides/voice-webrtc?api=live)). The API key and the prompt stay on the server.
- The page's data channel is locked down (`client.data_channel`): it can't send client events, so a visitor can't append instructions. It only receives `session.closed`.
- Luna's tools are live (`public.yaml → tools`). The call gets a Telegram status message (in `TELEGRAM_PUBLIC_CHAT_ID`'s group, if set) and can be steered. Calls are recorded and listed in the `public` channel with the visitor's IP (`CF-Connecting-IP`).
- The admin test call uses a WebSocket relay instead, to exercise the path real calls took over the media stream; the public page is the only WebRTC caller.

## Caps

`config/limits.yaml → public`: 10-minute calls, 3 at once, 20 per IP a day, 100 a day and $10 a day, counted from the call list over a rolling 24 h, so a restart doesn't reset them. The spend is the ended calls' stored cost (rolling summaries included): new calls are refused once it reaches the cap, and the call that crosses it runs to its end.

When the calls or the budget run out (or the page is closed, `public.yaml`), the page offers a "notify me" form (`POST /call/notify`, 5 sign-ups per IP a day). Its emails go in `notify_signups` with `list` = `notify`, the waitlist's with `list` = `waitlist`; reading them: [deploy.md](deploy.md).
