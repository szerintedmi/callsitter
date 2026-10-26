#!/usr/bin/env bash
# Prepares a fresh OVH VPS (Debian 13) for CallSitter; safe to re-run (docs/deploy.md). Copy this
# directory to the VPS and run it as root from there:
#
#   sudo ./bootstrap.sh                      Docker, cloudflared, deploy user, dirs, backups, maintenance, hardening
#   sudo ./bootstrap.sh lock-ssh --confirm   after SSH through the tunnel works: sshd on loopback only
#   sudo ./bootstrap.sh unlock-ssh           undo lock-ssh (from the OVH KVM console if the tunnel is down)
#
# Settings: /etc/callsitter/deploy.conf (created from deploy.conf.example on the first run).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CONF=/etc/callsitter/deploy.conf
APP_UID=1000 # the image's `bun` user
LISTEN_CONF=/etc/ssh/sshd_config.d/20-callsitter-listen.conf

log() { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ $(id -u) == 0 ]] || die "run as root (sudo)"

# Copies $1 to $2 with mode $3 (and owner $4); returns 0 only if $2 changed.
put() {
  local src=$1 dest=$2 mode=$3 owner=${4:-root:root}
  if [[ -f $dest ]] && cmp -s "$src" "$dest"; then return 1; fi
  install -m "$mode" -o "${owner%:*}" -g "${owner#*:}" "$src" "$dest"
}

lock_ssh() {
  [[ ${1:-} == --confirm ]] || die "first check that 'ssh <you>@\$SSH_HOST' works through the tunnel, then re-run with --confirm"
  systemctl is-active --quiet cloudflared || die "cloudflared isn't running"
  if systemctl is-active --quiet ssh.socket; then die "ssh.socket is active: ListenAddress would be ignored"; fi
  printf '# Only cloudflared (SSH_HOST) reaches sshd. Undo: bootstrap.sh unlock-ssh\nListenAddress 127.0.0.1\nListenAddress ::1\n' >"$LISTEN_CONF"
  sshd -t
  systemctl restart ssh
  log "sshd now listens on loopback only:"
  ss -tlnp | grep -E ':22\b' || true
  echo "Break-glass: log in to the OVH KVM console as your user (it needs a password: 'passwd <you>'), then 'sudo bootstrap.sh unlock-ssh'."
}

unlock_ssh() {
  rm -f "$LISTEN_CONF"
  sshd -t
  systemctl restart ssh
  log "sshd listens on all addresses again"
}

case ${1:-} in
  lock-ssh) shift; lock_ssh "$@"; exit ;;
  unlock-ssh) unlock_ssh; exit ;;
  "") ;;
  *) die "usage: bootstrap.sh [lock-ssh --confirm | unlock-ssh]" ;;
esac

# shellcheck source=/dev/null
. /etc/os-release
[[ ${VERSION_CODENAME:-} == trixie ]] || warn "written for Debian 13 (trixie); this is ${PRETTY_NAME:-unknown}"

log "settings ($CONF)"
install -d -m 0700 /etc/callsitter
if [[ ! -f $CONF ]]; then
  install -m 0600 "$HERE/deploy.conf.example" "$CONF"
  die "created $CONF: fill in DEPLOY_PUBKEY (and TUNNEL_ID once the tunnel exists), then re-run"
fi
# shellcheck source=/dev/null
. "$CONF"
[[ -n ${DEPLOY_PUBKEY:-} ]] || die "set DEPLOY_PUBKEY in $CONF"

log "packages: Docker (docker.com apt repo), cloudflared (pkg.cloudflare.com), base tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl unattended-upgrades qemu-guest-agent systemd-timesyncd
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
install -m 0755 -d /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  >/etc/apt/sources.list.d/cloudflared.list
apt-get update -q
# --no-upgrade: a re-run doesn't restart them under live calls; the maintenance timer upgrades them.
apt-get install -yq --no-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin cloudflared

# Debian security updates only (the default origins), without reboots. Docker, cloudflared and
# reboots are left to the nightly maintenance timer, which waits for a moment without calls.
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now qemu-guest-agent 2>/dev/null || warn "qemu-guest-agent not started (no guest channel?)"
# Keep the OVH console usable for a break-glass login:
# - systemd-ssh-generator (SSH over AF_VSOCK for VMs) fails on every daemon-reload here ("Failed to
#   query local AF_VSOCK CID"); nothing uses it.
# - Only kernel errors go to the console (routine Docker bridge/veth messages stay in the journal).
install -d -m 0755 /etc/systemd/system-generators
ln -sfn /dev/null /etc/systemd/system-generators/systemd-ssh-generator
echo 'kernel.printk = 3 4 1 3' >/etc/sysctl.d/90-callsitter-console.conf
sysctl -q -p /etc/sysctl.d/90-callsitter-console.conf
# A swapfile cushions short memory spikes, so the OOM killer doesn't pick sshd or cloudflared; low
# swappiness keeps the app's memory in RAM (swapping would stall call audio). The container has its
# own memory limit (deploy/compose.yaml).
# Rebuilt whenever it isn't active: an interrupted run can leave a file without a swap header.
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  rm -f /swapfile
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
echo 'vm.swappiness = 10' >/etc/sysctl.d/90-callsitter-swap.conf
sysctl -q -p /etc/sysctl.d/90-callsitter-swap.conf
# systemd-resolved answers LLMNR (port 5355) on all interfaces by default; nothing here needs it.
if systemctl is-active --quiet systemd-resolved; then
  install -d -m 0755 /etc/systemd/resolved.conf.d
  tmp=$(mktemp)
  printf '[Resolve]\nLLMNR=no\nMulticastDNS=no\n' >"$tmp"
  if put "$tmp" /etc/systemd/resolved.conf.d/10-callsitter.conf 0644; then systemctl restart systemd-resolved; fi
  rm -f "$tmp"
fi

log "Docker daemon"
# live-restore: containers (and calls) keep running while dockerd restarts, e.g. on upgrade.
if [[ ! -f /etc/docker/daemon.json ]]; then
  install -d -m 0755 /etc/docker
  printf '{\n  "live-restore": true,\n  "log-driver": "local"\n}\n' >/etc/docker/daemon.json
  systemctl restart docker
else
  grep -q '"live-restore": *true' /etc/docker/daemon.json || warn "/etc/docker/daemon.json exists without live-restore: true"
fi
systemctl enable --now docker

log "directories"
install -d -m 0755 /opt/callsitter
install -d -m 0700 /opt/callsitter/compose.d
install -d -m 0750 -o "$APP_UID" -g "$APP_UID" /var/lib/callsitter /var/lib/callsitter/backups
if [[ ! -f /etc/callsitter/callsitter.env ]]; then
  install -m 0600 "$HERE/callsitter.env.example" /etc/callsitter/callsitter.env
  warn "created /etc/callsitter/callsitter.env from the example: fill it in before the first deploy"
fi
chmod 0600 /etc/callsitter/callsitter.env "$CONF"

log "deploy user and commands"
if ! id deploy >/dev/null 2>&1; then
  adduser --system --group --home /home/deploy --shell /bin/sh --disabled-password deploy
fi
install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
tmp=$(mktemp)
printf 'restrict,command="/usr/local/bin/callsitter-deploy-ssh" %s\n' "$DEPLOY_PUBKEY" >"$tmp"
put "$tmp" /home/deploy/.ssh/authorized_keys 0600 deploy:deploy || true
rm -f "$tmp"
put "$HERE/callsitter-deploy" /usr/local/bin/callsitter-deploy 0755 || true
put "$HERE/callsitter-deploy-ssh" /usr/local/bin/callsitter-deploy-ssh 0755 || true
tmp=$(mktemp)
echo 'deploy ALL=(root) NOPASSWD: /usr/local/bin/callsitter-deploy' >"$tmp"
visudo -cqf "$tmp" || die "sudoers rule failed validation"
put "$tmp" /etc/sudoers.d/callsitter-deploy 0440 || true
rm -f "$tmp"

log "sshd hardening"
admin=${SUDO_USER:-}
admin_keys=$(getent passwd "${admin:-root}" | cut -d: -f6)/.ssh/authorized_keys
if [[ -s $admin_keys ]]; then
  tmp=$(mktemp)
  printf '# CallSitter bootstrap: keys only.\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' >"$tmp"
  if put "$tmp" /etc/ssh/sshd_config.d/10-callsitter.conf 0644; then sshd -t && systemctl reload ssh; fi
  rm -f "$tmp"
else
  warn "no SSH key in $admin_keys: password login left as it is (add a key, then re-run)"
fi

log "cloudflared"
if [[ -n ${TUNNEL_ID:-} && -f /etc/cloudflared/$TUNNEL_ID.json ]]; then
  chmod 0600 "/etc/cloudflared/$TUNNEL_ID.json"
  tmp=$(mktemp)
  sed -e "s/__TUNNEL_ID__/$TUNNEL_ID/g" -e "s/__HOOKS_HOST__/$HOOKS_HOST/g" \
    -e "s/__ADMIN_HOST__/$ADMIN_HOST/g" -e "s/__SSH_HOST__/$SSH_HOST/g" "$HERE/cloudflared.yml" >"$tmp"
  changed=""
  put "$tmp" /etc/cloudflared/config.yml 0644 && changed=1
  rm -f "$tmp"
  put "$HERE/cloudflared.service" /etc/systemd/system/cloudflared.service 0644 && changed=1
  systemctl daemon-reload
  systemctl enable cloudflared
  if [[ -n $changed ]] || ! systemctl is-active --quiet cloudflared; then
    # A restart drops SSH sessions and media streams that go through the tunnel.
    warn "restarting cloudflared (config changed)"
    systemctl restart cloudflared
  fi
  cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
else
  warn "tunnel not set up yet: set TUNNEL_ID in $CONF, copy the credentials to /etc/cloudflared/<TUNNEL_ID>.json, re-run"
fi

log "nightly backup and maintenance timers"
for unit in callsitter-backup.service callsitter-backup.timer callsitter-maintain.service \
  callsitter-maintain.timer callsitter-maintain-boot.service; do
  put "$HERE/$unit" "/etc/systemd/system/$unit" 0644 || true
done
systemctl daemon-reload
systemctl enable --now callsitter-backup.timer callsitter-maintain.timer
systemctl enable callsitter-maintain-boot.service

log "done"
echo "Listening TCP sockets (only sshd should be public; the app is on 127.0.0.1:8787):"
ss -tlnp
echo
echo "DEPLOY_KNOWN_HOSTS secret for GitHub Actions (this server's host key, read locally):"
echo "${SSH_HOST} $(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
[[ -f $LISTEN_CONF ]] || echo "Public SSH is still on: run 'bootstrap.sh lock-ssh --confirm' once SSH via ${SSH_HOST} works."
