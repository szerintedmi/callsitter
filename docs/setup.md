# Setup

What a dev machine (or a fresh production) needs besides `.env` (`.env.example` lists every key). Production itself: [deploy.md](deploy.md).

## Telnyx

Real calls reach gpt-live-1 over OpenAI SIP ([below](#openai-sip)). The Call Control application is still needed: the browser SIP test sends its webhooks there, and it's the fallback media-stream path (Telnyx answers, the app relays the audio to Live).

- Create a Call Control application with webhook URL `https://hooks.<domain>/telnyx/webhook` and assign the number to it.
- Copy the webhook public key into `TELNYX_PUBLIC_KEY`.

## Telegram

Optional: without it there are no status messages, rolling summaries or steering.

- Create a bot with [@BotFather](https://t.me/BotFather) and put its token in `TELEGRAM_BOT_TOKEN`.
- Message the bot from the owner's account, then read `message.chat.id` from `https://api.telegram.org/bot<token>/getUpdates` into `TELEGRAM_CHAT_ID` (a bot can't message someone who hasn't started a chat with it). Only that chat is heard.
- The app long-polls `getUpdates`, so no public URL is needed. Only one process can poll a bot, so dev needs its own bot.
- Optional: public-page calls can go to a group with `TELEGRAM_PUBLIC_CHAT_ID` (blank: everything goes to `TELEGRAM_CHAT_ID`). Add the bot to the group, send a message there, and read the negative chat id from `getUpdates`; if Telegram upgrades it to a supergroup, the id changes to `-100…`. The group gets fewer edits, shared across its calls, no transcript and no urgent alerts (`telegram.yaml → public`), since a group allows about 20 messages a minute.
- In a group, replies to the bot and its buttons work as they are. For a plain message to steer the newest public call (or a bare `/hangup`), turn privacy mode off (@BotFather → `/setprivacy` → Disable, then re-add the bot) or make the bot an admin.
- `/help` to the bot explains steering.

## Cloudflare tunnel

Copy [deploy/cloudflared.example.yml](../deploy/cloudflared.example.yml) to `deploy/cloudflared.yml` (gitignored) and run `bun run tunnel`.

- `hooks.<domain>` is public, but only the webhook, media and public-page paths are routed.
- `admin.<domain>` serves the admin UI behind Cloudflare Access. The app verifies the Access JWT itself (`ADMIN_AUTH=access`, with `ADMIN_HOST`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`), so a direct `127.0.0.1` request gets 403. It has its own hostname so it never shares a browser origin with the public page.
- Offline dev: `ADMIN_AUTH=none` serves the admin UI on loopback only (Host and Origin still checked).

## Divert the mobile

Divert your mobile to the Telnyx number (a phone setting).

## OpenAI SIP

gpt-live-1 answers the SIP leg itself ([voice-sip](https://developers.openai.com/api/docs/guides/voice-sip?api=live)). Telnyx sends the call to `sip:<project>@sip.api.openai.com;transport=tls`, OpenAI posts a signed `live.transport.incoming` webhook to `/openai/webhook`, and the app accepts the call with the `live.yaml` prompt and voice, then attaches a **sideband** WebSocket (`/v1/live/sessions/{id}/attach`). The rest is the normal call session:

- Steering goes out over the sideband as `session.instructions.append`, `session.thinking.append` or `session.commentary.append`.
- Audio doesn't pass through the app. The sideband reflects both directions (mono PCM16 24 kHz), recorded as a stereo WAV: caller left, agent right (`connection.yaml → sip.record`). It is written to `DATA_DIR/recordings/<call id>.wav.part` as the call goes (every 5 s, about 3 s behind), and renamed to `.wav` when the call ends; after a crash, startup finishes the `.part` and keeps it as the call's recording.
- Hangups go to `POST /v1/live/sessions/{id}/hangup`. When Live closes the session itself (`remote_hangup`, `connection_lost`), the call just ends: a hangup for a closed session stalls for over 5 s.
- Live keeps running through silence on its own; the silence watchdog listens to the reflected caller audio. Each call's log has the speech segments the watchdog heard and any gaps in that audio (`src/core/speech-trace.ts`).

To set it up:

1. `bun scripts/setup-sip.ts` (`--dry-run` first) creates the OpenAI webhook, a Telnyx credential connection that parks calls and sends webhooks to `/telnyx/webhook`, and a telephony credential for the browser test. It writes `OPENAI_PROJECT_ID`, `OPENAI_WEBHOOK_SECRET`, `TELNYX_SIP_CONNECTION_ID` and `TELNYX_SIP_CREDENTIAL_ID` to `.env`; restart the server (`--watch` doesn't reload `.env`).
2. For real calls, `bun scripts/direct-sip.ts on` (`status`, `off`, `--dry-run`), following [Telnyx's GPT-Live guide](https://developers.telnyx.com/docs/voice/sip-trunking/gpt-live-configuration-guide): an FQDN connection to `sip.api.openai.com:5061` with TLS, SRTP mandatory, G.711, media anchored in London; the number on it with "Translated Number" set to the project ID and Telnyx's dual-channel recording on; the OpenAI webhook pointed at `PUBLIC_WS_BASE`'s host (`PUBLIC_WS_BASE=wss://<production host> bun scripts/direct-sip.ts on` points it at production).

   This takes the number off the Call Control app. `off` restores what `on` saved in `DATA_DIR/direct-sip-restore.json`.

## Owner takeover

The owner can take a live phone call over from Telegram (`telegram.yaml → takeover`). A **Take over** button under the call's status message (the private chat only: Telegram refuses Mini App buttons in groups) opens `/takeover/<call id>` on the public host as a Telegram Mini App. Tapping **Start** asks for the microphone; the page plays the caller and sends the owner's voice, 16 kHz PCM over a WebSocket (`/takeover/ws/<call id>`). The page signs in with Telegram's `initData` (checked against the bot token, and the user must be `TELEGRAM_CHAT_ID`), then reconnects with a one-time token the server hands it, so a network blip doesn't need a fresh Telegram login.

The admin call page has a **Take over** button too (a live phone call, when takeover is set up): it opens `/calls/<call id>/takeover` in a new tab on the admin host, with its socket at `/calls/<call id>/takeover/ws`. Both sit behind the admin guard, so the Access JWT (or loopback with `ADMIN_AUTH=none`) is the owner check and the page sends no `initData`; the protocol, reconnects and stats are the same. The newest page wins: opening the other one moves the call there, and the older page says so.

What happens:

1. The agent gets `handover_text` as commentary and says it's putting the caller through (waited out up to `max_handover_wait_ms`). Jev, the silence watchdog, steering and the call-length limit stop.
2. Over OpenAI SIP, the app asks OpenAI to transfer the call (SIP REFER, `POST /v1/live/sessions/{id}/refer`) to `sip:cstakeover<token>@<TELNYX_TAKEOVER_SIP_DOMAIN>`. Telnyx sends that leg's `call.initiated` to `/telnyx/webhook`; the app matches the one-time token and answers it with an A-law media stream to `/media/takeover/…`, bridged to the page (about 2 s of silence for the caller). Over the media stream path there's no transfer: the bot just stops.
3. While taken over, the bot is out of the call. Steering answers "taken over"; `/hangup` hangs up at once. The call ends when either side hangs up, when the page is gone longer than `reconnect_grace_ms`, or after `max_seconds`.

If the transfer fails, the agent says `failed_text` and carries on; if the leg doesn't arrive within `leg_timeout_ms`, the call ends. Live is billed only up to the handover. Over SIP, the sideband's recording goes on through the takeover (the owner on the agent's track), as one WAV; over the media stream, Telnyx's recording covers the whole call. The owner's part isn't transcribed: Luna's summary says when the owner took over. A summary line in the call's log (`takeover` scope) gives the bridge's audio stats.

To set it up:

1. Mission Control → Call Control → the application → Inbound: give it a **SIP subdomain** (e.g. `callsitter` → `callsitter.sip.telnyx.com`). Set it to receive SIP URI calls only from your own connections (API: `sip_subdomain_receive_settings: only_my_connections`), since the transferred leg comes in over the FQDN connection to OpenAI. The FQDN connection doesn't need an outbound voice profile.
2. Set `TELNYX_TAKEOVER_SIP_DOMAIN` to that host and restart. Without it there's no button. Calls to the subdomain with an unknown, used or expired token are rejected, never answered as new calls.
3. `TELEGRAM_CHAT_ID` must be the owner's private chat with the bot, and `PUBLIC_WS_BASE` a `wss://` URL.
4. The tunnel must pass `/takeover/…` and `/assets/(takeover|test-call-worklet).js` on the public host (`deploy/cloudflared.example.yml`; production: re-run `bootstrap.sh`, [deploy.md](deploy.md)).
