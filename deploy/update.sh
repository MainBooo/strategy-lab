#!/usr/bin/env bash
# Safe update script for Strategy Lab.
# Backs up user data, installs deps, validates code + nginx config,
# restarts only the moex-strategy-lab service, and health-checks it.
set -euo pipefail

APP_DIR="/opt/moex-strategy-lab-v3"
BACKUP_ROOT="/opt/backups/moex-strategy-lab-v3"
SERVICE="moex-strategy-lab"
VENV_PY="$APP_DIR/.venv/bin/python"
VENV_PIP="$APP_DIR/.venv/bin/pip"
HEALTH_URL="http://127.0.0.1:5060/"

log() { echo "[update.sh] $(date '+%Y-%m-%d %H:%M:%S') $*"; }
fail() { echo "[update.sh] ERROR: $*" >&2; exit 1; }

# 1. Must run with root privileges (needed to restart systemd + reload nginx).
if [[ "$(id -u)" -ne 0 ]]; then
    fail "must be run as root (sudo $0)"
fi

[[ -d "$APP_DIR" ]] || fail "app directory $APP_DIR not found"
[[ -x "$VENV_PY" ]] || fail "virtualenv not found at $APP_DIR/.venv"

# 2. Backup user data before touching anything.
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_DIR="$BACKUP_ROOT/backup-$STAMP"
log "Backing up user data to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
for item in data results storage logs .env; do
    if [[ -e "$APP_DIR/$item" ]]; then
        cp -a "$APP_DIR/$item" "$BACKUP_DIR/" 2>&1 || fail "backup of $item failed"
    fi
done
log "Backup complete"

# 3. Data/results/storage/cache are never deleted by this script — only copied.

# 4. Install/update dependencies inside the existing virtualenv.
log "Installing dependencies"
"$VENV_PIP" install -q -r "$APP_DIR/requirements.txt" gunicorn \
    || fail "pip install failed"

# 5. Syntax-check all Python source before restarting anything.
log "Checking Python syntax"
find "$APP_DIR" -maxdepth 2 -name "*.py" -not -path "*/.venv/*" -print0 \
    | xargs -0 -n1 "$VENV_PY" -m py_compile \
    || fail "Python syntax check failed — aborting, service left untouched"

# 6. Validate nginx configuration (does not reload yet).
log "Checking nginx configuration"
nginx -t 2>&1 || fail "nginx config test failed — aborting, service left untouched"

# 7. Restart only this service — never touch other sites/processes.
log "Restarting $SERVICE"
systemctl restart "$SERVICE" || fail "failed to restart $SERVICE"

# Reload (not restart) nginx only after its config already validated above.
systemctl reload nginx || fail "failed to reload nginx"

# 8. Health check.
log "Waiting for service to come up"
for i in $(seq 1 15); do
    if curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then
        log "Health check passed"
        log "Update finished successfully"
        exit 0
    fi
    sleep 1
done

# 9. Non-zero exit on failure.
fail "health check failed after restart — check: journalctl -u $SERVICE -n 100"
