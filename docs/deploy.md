# Production deploy (OVH VPS)

CallSitter runs on an OVHcloud VPS (Debian 13) as one Docker container. GitHub Actions deploys each push to `main`.

- **App**: `deploy/compose.yaml`, image `ghcr.io/szerintedmi/callsitter` (private) pinned by digest. It listens on `127.0.0.1:8787`, with no public ports. SQLite, recordings, greetings and log files live in `/var/lib/callsitter` (`/data` in the container). Recordings are compressed to MP3 after each call ([Recordings](#recordings)).
- **Tunnel**: `cloudflared` runs on the host as a systemd service (`deploy/vps/cloudflared.yml`):
  - `callsitter.org` (public): the Telnyx/OpenAI webhooks, media streams, `/healthz`, the real call recordings (`/`, `/listen…`, `/assets/listen.js`), the "Get your own bot" waitlist (`/bot`) and the game (`/play`, `/call…`, `/assets/public.js`).
  - `admin.callsitter.org`: the admin UI behind Cloudflare Access. The app also verifies the Access JWT.
  - `ssh.callsitter.org`: SSH behind Cloudflare Access. Once `lock-ssh` has run, sshd listens on loopback only, so SSH works only through the tunnel.
- **Deploys**: `.github/workflows/deploy.yml` runs CI, builds the image (tagged `sha-<commit>`), then SSHes in with a deploy key. The key can only run `callsitter-deploy`, with a GitHub Access service token.
- **Secrets**: the app's settings and keys are in `/etc/callsitter/callsitter.env` (root, 0600), never in the image or GitHub. GitHub only holds the deploy credentials.

The repo is private on GitHub Free, so `main` can't be protected, and environment secrets aren't available. Deploy secrets are repository secrets, readable by workflows on any branch. That's acceptable while only you can push. The limits on what the deploy key can do are what contain a leak.

## What a deploy does

`callsitter-deploy deploy <image>@sha256:<digest>` on the VPS:

1. **Pulls** the image. The job's short-lived `GITHUB_TOKEN` arrives on stdin and goes into a throwaway Docker config, so no registry credential stays on the VPS.
2. **Drains** the running app (`scripts/control.ts drain`). New calls are **rejected as busy** (Telnyx `USER_BUSY`, SIP `486`), and it waits up to `DRAIN_WAIT` (21 min: a full call, call-flow.yaml `max_call_seconds`, plus its goodbye) for live calls to end. A call the owner extended from Telegram can outlast it.
   - If they don't end in time, the drain is lifted and the job fails with exit 75 ("deferred"). Nothing has changed; re-run the job later.
   - The drain expires by itself, so a deploy that dies can't leave calls blocked.
3. **Backs up** SQLite (`VACUUM INTO`) to `/var/lib/callsitter/backups/pre-deploy-<time>-<old digest>.db`. The last 10 are kept.
4. **Replaces** the container with the release's own `compose.yaml`, then waits for `/healthz`.
   - If the new release isn't healthy, it rolls back to the previous release and the job fails. The failed container's logs go to `/opt/callsitter/failed/` on the VPS (root-only), not to the job's log, which is public.
5. Records the release in `/opt/callsitter/releases` and keeps the last 5 images for offline rollback.

Calls get busy from the start of the drain until the new container is healthy, usually a few seconds after the last call ends. This isn't zero-downtime: SQLite has one writer, so two containers can't overlap.

Database migrations run on startup and **are not reversed** by a rollback. To undo one, restore the pre-deploy backup ([Restore](#restore)).

## One-time setup

### 1. Cloudflare (from your laptop)

You need your `cert.pem` (`--origincert`, as in `deploy/cloudflared.yml`).

```sh
cloudflared tunnel create callsitter-prod        # writes ~/.cloudflared/<PROD_ID>.json
cloudflared tunnel route dns <PROD_ID> ssh.callsitter.org
```

`route dns` only works in the zone `cert.pem` was issued for (geekmango.com). The callsitter.org records were made in the dashboard or the API instead: a proxied CNAME to `<PROD_ID>.cfargotunnel.com`.

Pass the tunnel **ID**, not the name: a default `~/.cloudflared/config.yml` can override the name.

Zero Trust → Access → Applications:

- **Add** a self-hosted app for `ssh.callsitter.org` with two policies:
  - *Allow*, with your email. This is for you from the laptop.
  - *Service Auth*, with a new service token `github-deploy`. Its Client ID and Secret become GitHub secrets. Note when it expires.
- **Keep** the existing Access app for `admin.callsitter.org`. Production keeps its AUD.

Don't move the public and admin hostnames yet; that's step 5.

### 2. VPS

1. Order the VPS with **Debian 13** and your SSH key. OVH's console needs a password, so set one for your user: `sudo passwd debian`.
2. Choose OVH automated backup (daily, 7 days), scheduled for **03:00 UTC or later**, after the 02:30 UTC SQLite copy.
3. Create the GitHub deploy key on your laptop: `ssh-keygen -t ed25519 -N '' -C github-actions-deploy@callsitter -f ~/.ssh/callsitter-github-deploy`. Keep it separate from the key you log in with: the deploy key can only run `callsitter-deploy`.
4. Copy the scripts and the tunnel credentials, then run the bootstrap twice:

   ```sh
   scp -r deploy/vps debian@<VPS_IP>:callsitter-vps
   scp ~/.cloudflared/<PROD_ID>.json debian@<VPS_IP>:
   ssh debian@<VPS_IP>
   sudo ./callsitter-vps/bootstrap.sh              # first run: creates /etc/callsitter/deploy.conf and stops
   sudo nano /etc/callsitter/deploy.conf           # DEPLOY_PUBKEY (~/.ssh/callsitter-github-deploy.pub), TUNNEL_ID=<PROD_ID>
   sudo install -D -m 0600 <PROD_ID>.json /etc/cloudflared/<PROD_ID>.json && rm <PROD_ID>.json
   sudo ./callsitter-vps/bootstrap.sh              # installs everything; prints the DEPLOY_KNOWN_HOSTS line
   sudo nano /etc/callsitter/callsitter.env        # from your .env; new MEDIA_TOKEN_SECRET
   ```

   `bootstrap.sh` sets up:
   - Docker (live-restore) and cloudflared from their apt repos;
   - unattended Debian security updates;
   - a 2 GB swapfile (swappiness 10);
   - the `deploy` user, whose key can only run `callsitter-deploy`;
   - the directories and the nightly backup timer;
   - keys-only sshd.

   It's safe to re-run after changing `deploy/vps`. It restarts cloudflared only when its config changed, and that drops SSH sessions and calls going through the tunnel.

5. Test SSH through the tunnel from the laptop. Add this to `~/.ssh/config`:

   ```
   Host callsitter-vps
     HostName ssh.callsitter.org
     User debian
     ProxyCommand cloudflared access ssh --hostname %h
   ```

   Then run `ssh callsitter-vps`; the first time, it opens the browser for Access.

6. Close public SSH: `sudo ./callsitter-vps/bootstrap.sh lock-ssh --confirm`. If the tunnel is ever down:
   - Use OVH's control-panel console and log in as **`debian`** with its password (`root` has none).
   - Run `sudo ~/callsitter-vps/bootstrap.sh unlock-ssh`.
   - Without a password, the fallback is OVH rescue mode: mount the disk and delete `/etc/ssh/sshd_config.d/20-callsitter-listen.conf`.

### 3. GitHub (repository secrets and variables)

```sh
gh secret set DEPLOY_SSH_KEY < ~/.ssh/callsitter-github-deploy
gh secret set DEPLOY_KNOWN_HOSTS --body 'ssh.callsitter.org ssh-ed25519 AAAA…'             # printed by bootstrap.sh
gh secret set CF_ACCESS_CLIENT_ID --body '<id>.access'
gh secret set CF_ACCESS_CLIENT_SECRET                                                     # paste when prompted
gh variable set DEPLOY_SSH_HOST --body ssh.callsitter.org                                 # enables the deploy job
```

- `DEPLOY_SSH_USER` is optional and defaults to `deploy`.
- Take the host key from `bootstrap.sh`'s output, which reads it on the server. Don't use `ssh-keyscan` over the network.
- After the first image push, check GHCR → package `callsitter` → *Manage Actions access*: this repository must have **read**. A package pushed by the repo's workflow is normally linked to it automatically.

### 4. First deploy

Merge to `main`, or run **Deploy** from the Actions tab. Then check it:

```sh
ssh callsitter-vps sudo callsitter-deploy status
ssh callsitter-vps curl -s 127.0.0.1:8787/healthz
```

### 5. Cutover (production takes the current hostnames)

1. Stop the laptop's `bun run tunnel` and `bun run dev`.
2. Point the hostnames at the production tunnel:

   ```sh
   cloudflared tunnel route dns --overwrite-dns <PROD_ID> callsitter.org
   cloudflared tunnel route dns --overwrite-dns <PROD_ID> admin.callsitter.org
   ```

   (Production moved from `scamsitter[-admin|-ssh].geekmango.com` to callsitter.org on 2026-10-16. The old public and admin hostnames 301 to the new ones through geekmango.com redirect rules; admin.callsitter.org and ssh.callsitter.org are extra destinations on the same Access apps, so `CF_ACCESS_AUD` didn't change.)

3. Place a test call, and open the admin UI.

Telnyx, and the OpenAI webhook if SIP is set up, already point at these hostnames, so they now reach production.

### 6. Dev after the cutover

- Dev has its own tunnel (`callsitter-dev`, `3280b78c…`) and hostnames:
  - `dev.callsitter.org`: public, same paths as production;
  - `dev-admin.callsitter.org`: its own Access app, so its own `CF_ACCESS_AUD` in `.env`.
- `deploy/cloudflared.yml` and `.env` (`PUBLIC_WS_BASE`, `ADMIN_HOST`, `CF_ACCESS_AUD`) point at them. Dev needs no service token.
- Dev gets no real phone calls. Use the browser test call (`/test-call`).
- Dev needs its own Telegram bot (`TELEGRAM_BOT_TOKEN`): the app long-polls for the owner's messages, and Telegram lets only one process poll a bot, so sharing production's would steal its messages. The same goes for `TELEGRAM_PUBLIC_CHAT_ID`: production's one bot serves both chats from one poll loop, so leave dev's blank, or point it at a group with dev's own bot in it.
- The browser **SIP** test in dev would need its own Telnyx credential connection and OpenAI webhook pointed at the dev hostnames (`scripts/setup-sip.ts`).

## Operations

Run these on the VPS (`ssh callsitter-vps`):

| Task | Command |
| --- | --- |
| Current release, health, active calls | `sudo callsitter-deploy status` |
| Logs (this container only: a deploy starts a new one) | `sudo docker compose --project-directory /opt/callsitter logs -f` |
| Log files (kept for `config/logging.yaml` → `retention_days`, 30 by default) | `sudo ls /var/lib/callsitter/logs`; one call: `sudo cat /var/lib/callsitter/logs/call-*-<call id>.jsonl` |
| Go back to the release that ran before this one (twice toggles back) | `sudo callsitter-deploy rollback` |
| Deploy a specific image (already on the VPS) | `sudo callsitter-deploy deploy ghcr.io/szerintedmi/callsitter@sha256:… </dev/null` |
| Stop / restart taking calls | `sudo callsitter-deploy drain` / `sudo callsitter-deploy resume` |

Rolling back to an older commit can also be done by reverting on `main`, which deploys the revert. Neither way undoes migrations.

### Investigating from the laptop

`bun run prod …` (`scripts/prod.ts`) copies production data into `data/prod/` over `ssh callsitter-vps`, using your login's sudo. It changes nothing on the VPS.

| Command | Copies |
| --- | --- |
| `bun run prod get-db` | A consistent copy of the database, taken inside the running container (`VACUUM INTO`, safe during calls), to `data/prod/callsitter-<time>.db`. |
| `bun run prod get-logs [--days 3]` | The log files changed in the last N days to `data/prod/logs/`. |
| `bun run prod get-call-log <call id>` | That call's log file, `call-<date>-<call id>.jsonl`. |
| `bun run prod get-recording <call id>` | The call's recordings to `data/prod/recordings/`. |

The copies hold callers' transcripts, numbers and voices. `data/` is gitignored; delete them when you're done. Then query locally, e.g. `sqlite3 data/prod/callsitter-….db "select id, started_at, verdict from calls order by started_at desc limit 10"` or `jq -c 'select(.level != "info")' data/prod/logs/call-*-<id>.jsonl`.

The public page's "notify me" sign-ups (emails left once the day's calls or budget ran out) are in the same copy. Those not yet told there's game again: `sqlite3 data/prod/callsitter-….db "select email, datetime(created_at/1000,'unixepoch'), reason, country from notify_signups where list = 'notify' and notified_at is null"`. The `/bot` waitlist is in the same table: `… where list = 'waitlist'`. Nothing sets `notified_at` yet: set it yourself on the server's database once you've mailed them (signing up again clears it).

**Call limits** (`config/limits.yaml`): once the phone number's calls that ended in the last 24 h have cost `phone.max_spend_usd_per_day` ($20), new callers hear busy (SIP 486: Telnyx `reject` with `USER_BUSY` over the media stream, `live.sessions.reject` over direct SIP) before any Live session starts; the call that crossed the cap runs to its end. Each declined call is stored as an ended call (`declined` set, ended by `system`, the spend in its end reason) and sends one notifying line to the main Telegram chat. The declined calls: `sqlite3 data/prod/callsitter-….db "select datetime(started_at/1000,'unixepoch'), \"from\", declined, end_reason from calls where declined is not null order by started_at desc"`. What the spend misses:
- Over direct SIP there's no Call Control, so no `call.cost`: the phone spend is OpenAI, Luna and Jev only. Over the media stream the carrier's bill is counted once it arrives after the hangup.
- A call's cost is stored when it ends (and updated by the summary and the carrier's bill), so live calls don't count until then.
- The owner's "+5 min" extensions aren't capped.

`config/` is baked into the image (`Dockerfile`; `deploy/compose.yaml` doesn't mount it), so changing a limit takes a push to `main` (a deploy). Leave a key out, or set it to null, for no limit.

**Maintenance**: Docker and cloudflared aren't upgraded automatically, because restarting either can drop calls. Drain first:

```sh
sudo callsitter-deploy drain
sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-compose-plugin
# cloudflared carries this SSH session: upgrade it detached, then reconnect
sudo systemd-run --unit=cf-upgrade sh -c 'apt-get install -y --only-upgrade cloudflared && systemctl restart cloudflared'
sudo callsitter-deploy resume     # after reconnecting
```

Reboots, e.g. after a kernel update, work the same way: `drain`, then `sudo reboot`. The container starts again on boot.

**Tunnel routes** (`deploy/vps/cloudflared.yml`, e.g. the public page's paths) aren't deployed by a push. Copy `deploy/vps` to the VPS and re-run `sudo ./callsitter-vps/bootstrap.sh` between calls (`drain` first): it restarts cloudflared, which drops calls and this SSH session.

**Rotations**:
- The Access service token expires; create a new one, then update both `CF_ACCESS_*` secrets.
- To rotate the deploy key, update `DEPLOY_PUBKEY` in `deploy.conf`, re-run `bootstrap.sh`, and update `DEPLOY_SSH_KEY`.

### Recordings

Each call is recorded as a WAV while it runs (`recordings/<call id>.wav`, about 5.8 MB a minute). After the call it's compressed to MP3 with `lame` (`<call id>.mp3`, about 0.4 MB a minute at 56 kbps), one at a time at low priority, and the call's recording becomes the MP3: the admin page plays it. A failed compression is in the call's log and leaves the WAV as the recording. A deploy doesn't wait for compressions: on startup, a background sweep compresses every WAV that is still its call's recording (cut off by a restart, or from before compression).

The WAVs are kept until `recordings.delete_wav_after_mp3` is turned on in `config/connection.yaml` (and deployed):
- From then on, each WAV is deleted as soon as its MP3 becomes the call's recording.
- The deploy's restart also deletes the WAVs kept before, in one go: every WAV whose call already plays the MP3. That can't be undone; the OVH backup still has them for 7 days ([Backups](#backups)). WAVs without a call, or that aren't their call's recording, are logged and left alone.

`recordings.mp3: false` turns compression off (new recordings stay WAV); `mp3_kbps` sets the bitrate. The demo tools take WAVs: `demos/README.md` says how to decode an MP3.

## Backups

| What | Where | When |
| --- | --- | --- |
| Whole disk (DB, recordings, config) | OVH automated backup, 7 days, OVH infrastructure | daily, 03:00 UTC or later |
| SQLite copy | `/var/lib/callsitter/backups/nightly-<weekday>.db` (7 kept) | 02:30 UTC (`callsitter-backup.timer`) |
| SQLite before each deploy | `/var/lib/callsitter/backups/pre-deploy-*.db` (10 kept) | every deploy |

The SQLite copies are made with `VACUUM INTO` (`scripts/backup-db.ts`), so they're consistent even while calls are being written. The OVH backup includes them, together with the recordings.

Deploys never remove `/var/lib/callsitter`. Don't run `docker compose down -v` or `docker system prune --volumes` either: the data is a bind mount, not a volume, but keep the habit.

### Restore

The database, from a local copy:

```sh
sudo callsitter-deploy drain
sudo docker compose --project-directory /opt/callsitter stop callsitter
cd /var/lib/callsitter
sudo mv callsitter.db callsitter.db.broken && sudo rm -f callsitter.db-wal callsitter.db-shm
sudo install -o 1000 -g 1000 -m 0640 backups/pre-deploy-….db callsitter.db
sudo docker compose --project-directory /opt/callsitter start callsitter
```

If the backup predates a migration, roll back to the release that matches it first (`sudo callsitter-deploy rollback`), then restore.

- **Files from an OVH backup**: OVH control panel → Backups → *Mount*. The backup appears as an extra disk; copy what you need. Unmounting reboots the VPS.
- **The whole VPS**: OVH → Backups → *Restore*. This overwrites the entire disk with that day's state.

## Testing the image locally

```sh
docker build --platform linux/amd64 -t callsitter:local .
CALLSITTER_IMAGE=callsitter:local CALLSITTER_ENV_FILE=$PWD/.env CALLSITTER_DATA_DIR=$PWD/data-docker \
  docker compose -f deploy/compose.yaml -p callsitter-local up
```

Stop the dev server first, since both use port 8787.
