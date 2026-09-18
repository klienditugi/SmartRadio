#!/usr/bin/env bash
# Production installer for Sub Wave AI (subwave-ai).
# Clone story: git clone <repo> subwave-ai && cd subwave-ai && sudo ./install.sh
#
# NEVER installs, updates, pulls, or manages Ollama/Qwen.
# Does not deploy to Oracle Cloud. Does not blindly overwrite existing units.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

MODE="${SUBWAVE_INSTALL_MODE:-systemd}"
NONINTERACTIVE=0
FORCE=0
SKIP_BUILD=0

usage() {
  cat <<'EOF'
Usage: ./install.sh [--mode systemd|compose] [--non-interactive] [--force] [--skip-build]

Configures Sub Wave AI in this clone directory (subwave-ai).

  --mode systemd   Host Node processes + systemd units (default on Linux)
  --mode compose   Docker Compose with host-mounted data/library
  --non-interactive  Read all values from the environment / .env (no prompts)
  --force          Replace existing systemd units or compose project (still never
                   touches unrelated services such as Ollama)
  --skip-build     Skip pnpm install/build (deps already present)

Environment (no hard-coded production IPs/hosts/creds/models):
  SUBWAVE_API_HOST SUBWAVE_API_PORT
  SUBWAVE_LIBRARY_DIR SUBWAVE_DOWNLOADS_DIR SUBWAVE_STAGING_DIR SUBWAVE_DB_PATH
  SUBWAVE_SECRETS_DIR SUBWAVE_ADMIN_USERNAME SUBWAVE_ADMIN_PASSWORD
  OLLAMA_BASE_URL OLLAMA_MODEL
  NAVIDROME_URL NAVIDROME_USER NAVIDROME_PASSWORD
  SUBWAVE_RADIO_URL SUBWAVE_RADIO_ADMIN_USER SUBWAVE_RADIO_ADMIN_PASSWORD
  SLSKD_URL SLSKD_API_KEY

Ollama is external only. This script will not apt/dnf/docker install ollama.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --non-interactive) NONINTERACTIVE=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "${MODE}" == "systemd" || "${MODE}" == "compose" ]] || die "mode must be systemd or compose"

prompt() {
  local var="$1" label="$2" secret="${3:-0}"
  local current="${!var:-}"
  if [[ -n "${current}" ]]; then
    return 0
  fi
  if [[ "${NONINTERACTIVE}" -eq 1 ]]; then
    return 0
  fi
  if [[ ! -t 0 && ! -r /dev/tty ]]; then
    return 0
  fi
  local reply=""
  if [[ "${secret}" -eq 1 ]]; then
    printf '%s: ' "${label}" > /dev/tty
    # shellcheck disable=SC2162
    read -s reply < /dev/tty || true
    printf '\n' > /dev/tty
  else
    printf '%s: ' "${label}" > /dev/tty
    # shellcheck disable=SC2162
    read reply < /dev/tty || true
  fi
  printf -v "${var}" '%s' "${reply}"
}

os_line="$(detect_os)"
info "OS/arch: ${os_line}"
check_resources "${ROOT}"
never_touch_ollama_msg

if [[ -f "${ROOT}/.env" ]]; then
  load_env_file "${ROOT}/.env"
fi

prompt SUBWAVE_API_HOST "API bind host (empty keeps 127.0.0.1 from example yaml)"
prompt SUBWAVE_API_PORT "API bind port (empty keeps example yaml)"
prompt SUBWAVE_LIBRARY_DIR "Persistent music library directory (host path, required for production)"
prompt SUBWAVE_DOWNLOADS_DIR "Downloads directory (host path)"
prompt SUBWAVE_STAGING_DIR "Staging directory (host path)"
prompt SUBWAVE_ADMIN_USERNAME "Admin username"
prompt SUBWAVE_ADMIN_PASSWORD "Admin password" 1
prompt OLLAMA_BASE_URL "External Ollama base URL (do not install Ollama here)"
prompt OLLAMA_MODEL "Ollama model already present on that host (no default)"
prompt NAVIDROME_URL "Navidrome base URL"
prompt NAVIDROME_USER "Navidrome username"
prompt NAVIDROME_PASSWORD "Navidrome password" 1
prompt SUBWAVE_RADIO_URL "SUB/WAVE radio base URL (opaque; may already include /api)"
prompt SUBWAVE_RADIO_ADMIN_USER "SUB/WAVE admin username"
prompt SUBWAVE_RADIO_ADMIN_PASSWORD "SUB/WAVE admin password" 1
prompt SLSKD_URL "slskd base URL"
prompt SLSKD_API_KEY "slskd API key" 1

DATA_DIR="${SUBWAVE_DATA_DIR:-${ROOT}/data}"
SECRETS_DIR="${SUBWAVE_SECRETS_DIR:-${ROOT}/secrets}"
DOWNLOADS_DIR="${SUBWAVE_DOWNLOADS_DIR:-${DATA_DIR}/downloads}"
STAGING_DIR="${SUBWAVE_STAGING_DIR:-${DATA_DIR}/staging}"
LIBRARY_DIR="${SUBWAVE_LIBRARY_DIR:-${DATA_DIR}/library}"
DB_PATH="${SUBWAVE_DB_PATH:-${DATA_DIR}/subwave.sqlite}"
CONFIG_PATH="${SUBWAVE_CONFIG:-${ROOT}/config/subwave.yaml}"

mkdir -p "${DATA_DIR}" "${SECRETS_DIR}" "${DOWNLOADS_DIR}" "${STAGING_DIR}" "${LIBRARY_DIR}" "${ROOT}/config"
chmod 700 "${SECRETS_DIR}" || true

write_secret() {
  local name="$1" value="$2"
  [[ -n "${value}" ]] || return 0
  local dest="${SECRETS_DIR}/${name}"
  if [[ -f "${dest}" && "${FORCE}" -ne 1 ]]; then
    info "keeping existing secret ${name}"
    return 0
  fi
  umask 077
  printf '%s\n' "${value}" > "${dest}"
  chmod 600 "${dest}"
}

write_secret admin_password "${SUBWAVE_ADMIN_PASSWORD:-}"
write_secret navidrome_password "${NAVIDROME_PASSWORD:-}"
write_secret subwave_admin_password "${SUBWAVE_RADIO_ADMIN_PASSWORD:-}"
write_secret slskd_api_key "${SLSKD_API_KEY:-}"
if [[ ! -f "${SECRETS_DIR}/session_secret" ]]; then
  umask 077
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "${SECRETS_DIR}/session_secret"
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${SECRETS_DIR}/session_secret"
    printf '\n' >> "${SECRETS_DIR}/session_secret"
  fi
  chmod 600 "${SECRETS_DIR}/session_secret"
fi

if [[ ! -f "${CONFIG_PATH}" ]]; then
  cp "${ROOT}/config/subwave.example.yaml" "${CONFIG_PATH}"
fi

ENV_OUT="${ROOT}/.env"
if [[ -f "${ENV_OUT}" && "${FORCE}" -ne 1 ]]; then
  info "keeping existing .env (pass --force to rewrite)"
else
  cat > "${ENV_OUT}" <<EOF
# Generated by install.sh. Do not commit. Ollama stays external.
SUBWAVE_CONFIG=${CONFIG_PATH}
SUBWAVE_CONFIG_DIR=${ROOT}/config
SUBWAVE_SECRETS_DIR=${SECRETS_DIR}
SUBWAVE_DATA_DIR=${DATA_DIR}
SUBWAVE_API_HOST=${SUBWAVE_API_HOST:-127.0.0.1}
SUBWAVE_API_PORT=${SUBWAVE_API_PORT:-8788}
SUBWAVE_DB_PATH=${DB_PATH}
SUBWAVE_DOWNLOADS_DIR=${DOWNLOADS_DIR}
SUBWAVE_STAGING_DIR=${STAGING_DIR}
SUBWAVE_LIBRARY_DIR=${LIBRARY_DIR}
SUBWAVE_ADMIN_USERNAME=${SUBWAVE_ADMIN_USERNAME:-admin}
SUBWAVE_WEB_DIST=${ROOT}/apps/web/dist
OLLAMA_BASE_URL=${OLLAMA_BASE_URL:-}
OLLAMA_MODEL=${OLLAMA_MODEL:-}
NAVIDROME_URL=${NAVIDROME_URL:-}
NAVIDROME_USER=${NAVIDROME_USER:-}
SUBWAVE_RADIO_URL=${SUBWAVE_RADIO_URL:-}
SUBWAVE_RADIO_ADMIN_USER=${SUBWAVE_RADIO_ADMIN_USER:-}
SLSKD_URL=${SLSKD_URL:-}
EOF
  chmod 600 "${ENV_OUT}"
  info "wrote ${ENV_OUT}"
fi

if [[ "${SKIP_BUILD}" -eq 0 ]]; then
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 20+ is required. Install it on the host, then re-run. This installer will not install Ollama."
  fi
  NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
  if [[ "${NODE_MAJOR}" -lt 20 ]]; then
    die "Node.js 20+ required (found $(node -v))"
  fi
  if ! command -v pnpm >/dev/null 2>&1; then
    info "enabling pnpm via corepack"
    if command -v corepack >/dev/null 2>&1; then
      corepack enable
      corepack prepare pnpm@10.33.3 --activate
    else
      die "pnpm is required (corepack not available)"
    fi
  fi
  info "installing JavaScript dependencies"
  (cd "${ROOT}" && pnpm install --frozen-lockfile)
  info "building web UI"
  (cd "${ROOT}" && pnpm --filter @subwave-ai/web build)
fi

if [[ "${MODE}" == "compose" ]]; then
  need_cmd docker
  if [[ -f "${ROOT}/deploy/docker-compose.yml" ]]; then
    if docker compose ls >/dev/null 2>&1; then
      COMPOSE=(docker compose)
    else
      COMPOSE=(docker-compose)
    fi
    info "starting compose project (host mounts for data + library)"
    (cd "${ROOT}" && "${COMPOSE[@]}" -f deploy/docker-compose.yml --env-file "${ENV_OUT}" up -d --build)
  else
    die "deploy/docker-compose.yml missing"
  fi
else
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemd not found; skipping unit install. Use --mode compose or run pnpm dev:api / pnpm dev:worker."
  else
    if ! is_root; then
      warn "not root: writing unit templates to deploy/systemd only. Re-run with sudo to install units."
    else
      RUN_USER="${SUDO_USER:-subwave}"
      if ! id "${RUN_USER}" >/dev/null 2>&1; then
        RUN_USER="root"
      fi
      for unit in subwave-api subwave-worker; do
        dest="/etc/systemd/system/${unit}.service"
        if [[ -f "${dest}" && "${FORCE}" -ne 1 ]]; then
          warn "existing ${dest} left untouched (pass --force to replace). Not modifying other services."
          continue
        fi
        sed \
          -e "s|@ROOT@|${ROOT}|g" \
          -e "s|@USER@|${RUN_USER}|g" \
          "${ROOT}/deploy/systemd/${unit}.service.in" > "${dest}"
        info "installed ${dest}"
      done
      systemctl daemon-reload
      systemctl enable --now subwave-api.service subwave-worker.service
    fi
  fi
fi

load_env_file "${ENV_OUT}"
print_web_url
info "doctor: ${ROOT}/doctor.sh"
info "Ollama was not installed or modified."
info "Music library path: ${LIBRARY_DIR} (host persistent)"
if [[ -z "${OLLAMA_MODEL:-}" ]]; then
  warn "OLLAMA_MODEL is empty. The API will not start until you set a model already present on the external Ollama host."
fi

if command -v curl >/dev/null 2>&1; then
  host="${SUBWAVE_API_HOST:-127.0.0.1}"
  port="${SUBWAVE_API_PORT:-8788}"
  if [[ "${host}" == "0.0.0.0" ]]; then host="127.0.0.1"; fi
  sleep 1
  if curl -fsS "http://${host}:${port}/api/v1/health" >/dev/null 2>&1; then
    info "health check: ok"
  else
    warn "health check did not succeed yet — start the API or check journalctl -u subwave-api"
  fi
fi
