# Production deploy (OVH VPS)

ScamSitter runs on an OVHcloud VPS (Debian 13) as one Docker container. GitHub Actions deploys each push to `main`.

- **App**: `deploy/compose.yaml`, image `ghcr.io/szerintedmi/scamsitter` (private) pinned by digest. It listens on `127.0.0.1:8787`, with no public ports. SQLite, recordings and greetings live in `/var/lib/scamsitter` (`/data` in the container).
- **Tunnel**: `cloudflared` runs on the host as a systemd service (`deploy/vps/cloudflared.yml`):
  - `scamsitter.geekmango.com` (public): only the Telnyx/OpenAI webhooks, media streams and `/healthz`.
  - `scamsitter-admin.geekmango.com`: the admin UI behind Cloudflare Access. The app also verifies the Access JWT.
  - `scamsitter-ssh.geekmango.com`: SSH behind Cloudflare Access. Once `lock-ssh` has run, sshd listens on loopback only, so SSH works only through the tunnel.
- **Deploys**: `.github/workflows/deploy.yml` runs CI, builds the image (tagged `sha-<commit>`), then SSHes in with a deploy key. The key can only run `scamsitter-deploy`, with a GitHub Access service token.
- **Secrets**: the app's settings and keys are in `/etc/scamsitter/scamsitter.env` (root, 0600), never in the image or GitHub. GitHub only holds the deploy credentials.

The repo is private on GitHub Free, so `main` can't be protected, and environment secrets aren't available. Deploy secrets are repository secrets, readable by workflows on any branch. That's acceptable while only you can push. The limits on what the deploy key can do are what contain a leak.

## What a deploy does

`scamsitter-deploy deploy <image>@sha256:<digest>` on the VPS:

1. **Pulls** the image. The job's short-lived `GITHUB_TOKEN` arrives on stdin and goes into a throwaway Docker config, so no registry credential stays on the VPS.
2. **Drains** the running app (`scripts/control.ts drain`). New calls are **rejected as busy** (Telnyx `USER_BUSY`, SIP `486`), and it waits up to `DRAIN_WAIT` (15 min) for live calls to end.
   - If they don't end in time, the drain is lifted and the job fails with exit 75 ("deferred"). Nothing has changed; re-run the job later.
   - The drain expires by itself, so a deploy that dies can't leave calls blocked.
3. **Backs up** SQLite (`VACUUM INTO`) to `/var/lib/scamsitter/backups/pre-deploy-<time>-<old digest>.db`. The last 10 are kept.
4. **Replaces** the container with the release's own `compose.yaml`, then waits for `/healthz`.
   - If the new release isn't healthy, it rolls back to the previous release and the job fails.
5. Records the release in `/opt/scamsitter/releases` and keeps the last 5 images for offline rollback.

Calls get busy from the start of the drain until the new container is healthy, usually a few seconds after the last call ends. This isn't zero-downtime: SQLite has one writer, so two containers can't overlap.

Database migrations run on startup and **are not reversed** by a rollback. To undo one, restore the pre-deploy backup ([Restore](#restore)).

## One-time setup

### 1. Cloudflare (from your laptop)

You need your `cert.pem` (`--origincert`, as in `deploy/cloudflared.yml`).

```sh
cloudflared tunnel create scamsitter-prod        # writes ~/.cloudflared/<PROD_ID>.json
cloudflared tunnel route dns <PROD_ID> scamsitter-ssh.geekmango.com
```

Pass the tunnel **ID**, not the name: a default `~/.cloudflared/config.yml` can override the name.

Zero Trust → Access → Applications:

- **Add** a self-hosted app for `scamsitter-ssh.geekmango.com` with two policies:
  - *Allow*, with your email. This is for you from the laptop.
  - *Service Auth*, with a new service token `github-deploy`. Its Client ID and Secret become GitHub secrets. Note when it expires.
- **Keep** the existing Access app for `scamsitter-admin.geekmango.com`. Production keeps its AUD.

Don't move the public and admin hostnames yet; that's step 5.

### 2. VPS

1. Order the VPS with **Debian 13** and your SSH key. OVH's console needs a password, so set one for your user: `sudo passwd debian`.
2. Choose OVH automated backup (daily, 7 days), scheduled for **03:00 UTC or later**, after the 02:30 UTC SQLite copy.
3. Create the GitHub deploy key on your laptop: `ssh-keygen -t ed25519 -N '' -C github-actions-deploy@scamsitter -f ~/.ssh/scamsitter-github-deploy`. Keep it separate from the key you log in with: the deploy key can only run `scamsitter-deploy`.
4. Copy the scripts and the tunnel credentials, then run the bootstrap twice:

   ```sh
   scp -r deploy/vps debian@<VPS_IP>:scamsitter-vps
   scp ~/.cloudflared/<PROD_ID>.json debian@<VPS_IP>:
   ssh debian@<VPS_IP>
   sudo ./scamsitter-vps/bootstrap.sh              # first run: creates /etc/scamsitter/deploy.conf and stops
   sudo nano /etc/scamsitter/deploy.conf           # DEPLOY_PUBKEY (~/.ssh/scamsitter-github-deploy.pub), TUNNEL_ID=<PROD_ID>
   sudo install -D -m 0600 <PROD_ID>.json /etc/cloudflared/<PROD_ID>.json && rm <PROD_ID>.json
   sudo ./scamsitter-vps/bootstrap.sh              # installs everything; prints the DEPLOY_KNOWN_HOSTS line
   sudo nano /etc/scamsitter/scamsitter.env        # from your .env; new MEDIA_TOKEN_SECRET
   ```

   `bootstrap.sh` sets up:
   - Docker (live-restore) and cloudflared from their apt repos;
   - unattended Debian security updates;
   - the `deploy` user, whose key can only run `scamsitter-deploy`;
   - the directories and the nightly backup timer;
   - keys-only sshd.

   It's safe to re-run after changing `deploy/vps`. It restarts cloudflared only when its config changed, and that drops SSH sessions and calls going through the tunnel.

5. Test SSH through the tunnel from the laptop. Add this to `~/.ssh/config`:

   ```
   Host scamsitter-vps
     HostName scamsitter-ssh.geekmango.com
     User debian
     ProxyCommand cloudflared access ssh --hostname %h
   ```

   Then run `ssh scamsitter-vps`; the first time, it opens the browser for Access.

6. Close public SSH: `sudo ./scamsitter-vps/bootstrap.sh lock-ssh --confirm`. If the tunnel is ever down, use OVH's control-panel console and run `bootstrap.sh unlock-ssh`.

### 3. GitHub (repository secrets and variables)

```sh
gh secret set DEPLOY_SSH_KEY < ~/.ssh/scamsitter-github-deploy
gh secret set DEPLOY_KNOWN_HOSTS --body 'scamsitter-ssh.geekmango.com ssh-ed25519 AAAA…'   # printed by bootstrap.sh
gh secret set CF_ACCESS_CLIENT_ID --body '<id>.access'
gh secret set CF_ACCESS_CLIENT_SECRET                                                     # paste when prompted
gh variable set DEPLOY_SSH_HOST --body scamsitter-ssh.geekmango.com                       # enables the deploy job
```

- `DEPLOY_SSH_USER` is optional and defaults to `deploy`.
- Take the host key from `bootstrap.sh`'s output, which reads it on the server. Don't use `ssh-keyscan` over the network.
- After the first image push, check GHCR → package `scamsitter` → *Manage Actions access*: this repository must have **read**. A package pushed by the repo's workflow is normally linked to it automatically.

### 4. First deploy

Merge to `main`, or run **Deploy** from the Actions tab. Then check it:

```sh
ssh scamsitter-vps sudo scamsitter-deploy status
ssh scamsitter-vps curl -s 127.0.0.1:8787/healthz
```

### 5. Cutover (production takes the current hostnames)

1. Stop the laptop's `bun run tunnel` and `bun run dev`.
2. Point the hostnames at the production tunnel:

   ```sh
   cloudflared tunnel route dns --overwrite-dns <PROD_ID> scamsitter.geekmango.com
   cloudflared tunnel route dns --overwrite-dns <PROD_ID> scamsitter-admin.geekmango.com
   ```

3. Place a test call, and open the admin UI.

Telnyx, and the OpenAI webhook if SIP is set up, already point at these hostnames, so they now reach production.

### 6. Dev after the cutover

- The old tunnel (`b190c780…`) becomes dev. Pick new hostnames, route them to that tunnel, and update:
  - `deploy/cloudflared.yml`;
  - `.env`: `PUBLIC_WS_BASE`, `ADMIN_HOST`, and `CF_ACCESS_AUD` from a new Access app for the dev admin host.
- Dev gets no real phone calls. Use the browser test call (`/test-call`).
- The browser **SIP** test in dev would need its own Telnyx credential connection and OpenAI webhook pointed at the dev hostnames (`scripts/setup-sip.ts`).

## Operations

Run these on the VPS (`ssh scamsitter-vps`):

| Task | Command |
| --- | --- |
| Current release, health, active calls | `sudo scamsitter-deploy status` |
| Logs | `sudo docker compose --project-directory /opt/scamsitter logs -f` |
| Go back to the release that ran before this one (twice toggles back) | `sudo scamsitter-deploy rollback` |
| Deploy a specific image (already on the VPS) | `sudo scamsitter-deploy deploy ghcr.io/szerintedmi/scamsitter@sha256:… </dev/null` |
| Stop / restart taking calls | `sudo scamsitter-deploy drain` / `sudo scamsitter-deploy resume` |

Rolling back to an older commit can also be done by reverting on `main`, which deploys the revert. Neither way undoes migrations.

**Maintenance**: Docker and cloudflared aren't upgraded automatically, because restarting either can drop calls. Drain first:

```sh
sudo scamsitter-deploy drain
sudo apt-get update && sudo apt-get install --only-upgrade docker-ce docker-ce-cli containerd.io docker-compose-plugin
# cloudflared carries this SSH session: upgrade it detached, then reconnect
sudo systemd-run --unit=cf-upgrade sh -c 'apt-get install -y --only-upgrade cloudflared && systemctl restart cloudflared'
sudo scamsitter-deploy resume     # after reconnecting
```

Reboots, e.g. after a kernel update, work the same way: `drain`, then `sudo reboot`. The container starts again on boot.

**Rotations**:
- The Access service token expires; create a new one, then update both `CF_ACCESS_*` secrets.
- To rotate the deploy key, update `DEPLOY_PUBKEY` in `deploy.conf`, re-run `bootstrap.sh`, and update `DEPLOY_SSH_KEY`.

## Backups

| What | Where | When |
| --- | --- | --- |
| Whole disk (DB, recordings, config) | OVH automated backup, 7 days, OVH infrastructure | daily, 03:00 UTC or later |
| SQLite copy | `/var/lib/scamsitter/backups/nightly-<weekday>.db` (7 kept) | 02:30 UTC (`scamsitter-backup.timer`) |
| SQLite before each deploy | `/var/lib/scamsitter/backups/pre-deploy-*.db` (10 kept) | every deploy |

The SQLite copies are made with `VACUUM INTO` (`scripts/backup-db.ts`), so they're consistent even while calls are being written. The OVH backup includes them, together with the recordings.

Deploys never remove `/var/lib/scamsitter`. Don't run `docker compose down -v` or `docker system prune --volumes` either: the data is a bind mount, not a volume, but keep the habit.

### Restore

The database, from a local copy:

```sh
sudo scamsitter-deploy drain
sudo docker compose --project-directory /opt/scamsitter stop scamsitter
cd /var/lib/scamsitter
sudo mv scamsitter.db scamsitter.db.broken && sudo rm -f scamsitter.db-wal scamsitter.db-shm
sudo install -o 1000 -g 1000 -m 0640 backups/pre-deploy-….db scamsitter.db
sudo docker compose --project-directory /opt/scamsitter start scamsitter
```

If the backup predates a migration, roll back to the release that matches it first (`sudo scamsitter-deploy rollback`), then restore.

- **Files from an OVH backup**: OVH control panel → Backups → *Mount*. The backup appears as an extra disk; copy what you need. Unmounting reboots the VPS.
- **The whole VPS**: OVH → Backups → *Restore*. This overwrites the entire disk with that day's state.

## Testing the image locally

```sh
docker build --platform linux/amd64 -t scamsitter:local .
SCAMSITTER_IMAGE=scamsitter:local SCAMSITTER_ENV_FILE=$PWD/.env SCAMSITTER_DATA_DIR=$PWD/data-docker \
  docker compose -f deploy/compose.yaml -p scamsitter-local up
```

Stop the dev server first, since both use port 8787.
