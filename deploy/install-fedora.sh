#!/usr/bin/env bash
#
# Deploys shorturl-dashboard on Fedora / RHEL / CentOS Stream.
# Run from a clone of the repository:  sudo ./deploy/install-fedora.sh
#
# Idempotent: safe to re-run to upgrade an existing install.

set -euo pipefail

BIN=/usr/local/bin/shorturl
ENV_DIR=/etc/shorturl
ENV_FILE="$ENV_DIR/shorturl.env"
UNIT=/etc/systemd/system/shorturl.service
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

die() {
	echo "error: $*" >&2
	exit 1
}
[[ $EUID -eq 0 ]] || die "run this as root (sudo $0)"

# --- 1. Deno ------------------------------------------------------------------
if ! command -v deno >/dev/null 2>&1; then
	echo "==> Installing Deno"
	dnf install -y unzip curl
	# Installs to /root/.deno by default; we only need it to build the binary.
	curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y
fi
export PATH="/usr/local/bin:$PATH"
command -v deno >/dev/null || die "deno is still not on PATH"

# --- 2. Build a single self-contained binary ----------------------------------
# Compiling bakes the permission set into the executable: even if someone edits
# the unit file later, the process still cannot read outside its data dir.
echo "==> Building $BIN"
cd "$REPO_ROOT"
deno compile \
	--allow-net \
	--allow-read=/var/lib/shorturl \
	--allow-write=/var/lib/shorturl \
	--allow-env \
	--output /tmp/shorturl-build \
	src/main.ts
install -m 0755 /tmp/shorturl-build "$BIN"
rm -f /tmp/shorturl-build

# --- 3. Configuration ---------------------------------------------------------
install -d -m 0750 "$ENV_DIR"
if [[ ! -f "$ENV_FILE" ]]; then
	echo "==> Creating $ENV_FILE"
	install -m 0600 "$REPO_ROOT/.env.example" "$ENV_FILE"
	sed -i \
		-e 's|^DATA_DIR=.*|DATA_DIR=/var/lib/shorturl|' \
		-e 's|^HOST=.*|HOST=127.0.0.1|' \
		-e 's|^TRUST_PROXY=.*|TRUST_PROXY=true|' \
		"$ENV_FILE"
	echo
	echo "    !! Edit $ENV_FILE before starting:"
	echo "       - BASE_URL             your public https URL"
	echo "       - ADMIN_PASSWORD_HASH  run: deno task hash-password"
	echo "       - DISCORD_WEBHOOK_URL  optional"
	echo
else
	echo "==> Keeping existing $ENV_FILE"
fi
chmod 0600 "$ENV_FILE"

# --- 4. systemd ---------------------------------------------------------------
echo "==> Installing systemd unit"
install -m 0644 "$REPO_ROOT/deploy/shorturl.service" "$UNIT"
systemctl daemon-reload

# --- 5. SELinux ---------------------------------------------------------------
# Fedora runs SELinux in enforcing mode. A binary in /usr/local/bin launched by
# systemd needs the bin_t type, and the confined reverse proxy needs permission
# to open a local TCP connection to our port.
if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" != "Disabled" ]]; then
	echo "==> Applying SELinux labels"
	command -v restorecon >/dev/null && restorecon -v "$BIN" || true
	if command -v setsebool >/dev/null 2>&1; then
		# Lets nginx/Caddy reverse_proxy to 127.0.0.1:8000.
		setsebool -P httpd_can_network_connect 1 || true
	fi
fi

# --- 6. firewalld -------------------------------------------------------------
# Only 80/443 are exposed; port 8000 stays bound to loopback and must NOT be
# opened to the network.
if systemctl is-active --quiet firewalld; then
	echo "==> Opening http/https in firewalld"
	firewall-cmd --permanent --add-service=http --quiet || true
	firewall-cmd --permanent --add-service=https --quiet || true
	firewall-cmd --reload --quiet || true
fi

echo
echo "Done. Next:"
echo "  1. \$EDITOR $ENV_FILE"
echo "  2. systemctl enable --now shorturl"
echo "  3. journalctl -u shorturl -f"
echo "  4. put Caddy in front — see deploy/Caddyfile"
