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
      echo "Usage: sudo ./update.sh [--force]"
      echo "Pulls git, reinstalls deps, rebuilds the web UI, and restarts the install mode already in use."
      echo "systemd and Docker Compose are exclusive. A systemd install never starts the subwave-ai compose project."
      echo "Docker used by another project (slskd's smartradio-slskd) does not select Compose."
      echo "If the API port is held by anything other than the unit or container being restarted, this script stops and names that process. It does not kill it."
      echo "--force does not switch install mode, kill processes, or overwrite .env, secrets, config, or data."
      echo "When run as root, pnpm install and the web build run as the owner of this directory."
      echo "Does not install or update Ollama. Does not overwrite .env, secrets, config, or library files."
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

run_project_js_build "${ROOT}"

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

if [[ "${FORCE}" -eq 1 ]]; then
  info "--force does not switch install mode, kill processes, or overwrite .env, secrets, config, or data"
fi

# Mode comes from .subwave-install-mode, otherwise from installed unit files,
# otherwise from an existing subwave-ai compose project. Docker merely being
# installed is not a compose install. Never pipe systemctl into grep -q:
# under pipefail that test can exit 141 (SIGPIPE) and fall through to Compose.
restart_managed_services "${ROOT}"

print_web_url
info "update complete (Ollama untouched)"
