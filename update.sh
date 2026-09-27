#!/usr/bin/env bash
# Update Sub Wave AI in the local clone directory named subwave-ai. Never touches Ollama. Never overwrites secrets/config/data
# unless git itself would; yaml/secrets/data are gitignored.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: ./update.sh [--force]"
      echo "Pulls git, reinstalls deps, rebuilds the web UI, restarts units/compose."
      echo "Does not install or update Ollama. Does not overwrite .env, secrets, or library files."
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

never_touch_ollama_msg
need_cmd git
cd "${ROOT}"
info "fetching origin"
git fetch origin
info "pulling current branch (rebase)"
git pull --rebase --autostash origin "$(git rev-parse --abbrev-ref HEAD)" || warn "git pull failed — resolve locally and retry"

need_cmd node
need_cmd pnpm
pnpm install --frozen-lockfile
pnpm --filter @subwave-ai/web build

if [[ -f "${ROOT}/.env" ]]; then
  load_env_file "${ROOT}/.env"
fi

SECRETS_DIR="${SUBWAVE_SECRETS_DIR:-${ROOT}/secrets}"
mkdir -p "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}" || true
if [[ ! -f "${SECRETS_DIR}/verification_hmac_key" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand 32 > "${SECRETS_DIR}/verification_hmac_key"
  else
    head -c 32 /dev/urandom > "${SECRETS_DIR}/verification_hmac_key"
  fi
  chmod 600 "${SECRETS_DIR}/verification_hmac_key"
  info "created secrets/verification_hmac_key (stored test-connection HMAC; not the session secret)"
fi

if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^subwave-api.service'; then
  if is_root; then
    systemctl restart subwave-api.service subwave-worker.service
    info "restarted systemd units"
  else
    warn "systemd units present; re-run as root to restart"
  fi
elif command -v docker >/dev/null 2>&1 && [[ -f "${ROOT}/deploy/docker-compose.yml" ]]; then
  if docker compose ls >/dev/null 2>&1; then
    docker compose -f "${ROOT}/deploy/docker-compose.yml" --env-file "${ROOT}/.env" up -d --build
  fi
else
  info "no managed services detected; start with pnpm dev:api / pnpm dev:worker"
fi

print_web_url
info "update complete (Ollama untouched)"
