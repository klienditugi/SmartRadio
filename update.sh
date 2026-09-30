#!/usr/bin/env bash
# Update Sub Wave AI in the local clone directory named subwave-ai. Never touches Ollama. Never overwrites secrets/config/data
# unless git itself would; yaml/secrets/data are gitignored.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

# Paths this process has already read. git pull can replace them on disk
# while this shell keeps the old script body and the old sourced functions.
# The next update after a fix would otherwise finish on the pre-pull code.
update_loaded_scripts() {
  local root="$1" script="" line="" path=""
  script="${root}/update.sh"
  printf '%s\n' "${script}"
  printf '%s\n' "${root}/scripts/ops-common.sh"
  [[ -f "${script}" ]] || return 0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    [[ "${line}" =~ ^[[:space:]]*# ]] && continue
    [[ "${line}" =~ ^[[:space:]]*(source|\.)[[:space:]]+([^[:space:];#]+) ]] || continue
    path="${BASH_REMATCH[2]}"
    path="${path#\"}"
    path="${path%\"}"
    path="${path#\'}"
    path="${path%\'}"
    path="${path//\$\{ROOT\}/${root}}"
    path="${path//\$ROOT/${root}}"
    [[ -n "${path}" ]] || continue
    printf '%s\n' "${path}"
  done < "${script}"
}

update_script_fingerprint() {
  local root="$1" file="" hash=""
  while IFS= read -r file; do
    [[ -n "${file}" ]] || continue
    if [[ -f "${file}" ]]; then
      hash="$(sha256sum -- "${file}")"
      hash="${hash%% *}"
    else
      hash="absent"
    fi
    printf '%s %s\n' "${hash}" "${file}"
  done < <(update_loaded_scripts "${root}" | awk '!seen[$0]++')
}

# Hash before the pull and again after it. Re-exec at most once so a later
# pull cannot loop. SUBWAVE_UPDATE_REEXEC skips fetch, pull, and this check.
reexec_if_update_scripts_changed() {
  local root="$1"
  shift
  local before="" after=""
  need_cmd sha256sum
  before="$(update_script_fingerprint "${root}")"
  update_git_checkout "${root}"
  after="$(update_script_fingerprint "${root}")"
  [[ "${before}" == "${after}" ]] && return 0
  if [[ "$#" -gt 0 ]]; then
    info "git pull changed update.sh or a script it sources; re-running ./update.sh $*"
  else
    info "git pull changed update.sh or a script it sources; re-running ./update.sh"
  fi
  if [[ ! -f "${root}/update.sh" || ! -x "${root}/update.sh" ]]; then
    die "failed to re-exec ${root}/update.sh"
  fi
  export SUBWAVE_UPDATE_REEXEC=1
  if [[ "$#" -gt 0 ]]; then
    exec "${root}/update.sh" "$@"
  else
    exec "${root}/update.sh"
  fi
  die "failed to re-exec ${root}/update.sh"
}

ORIGINAL_ARGS=()
if [[ "$#" -gt 0 ]]; then
  ORIGINAL_ARGS=("$@")
fi

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
      echo "When run as root, git (fetch, pull, and rev-parse), pnpm install, and the web build run as the owner of this directory."
      echo "If git pull changes this script or a script it sources, the pulled ./update.sh is re-run once with the same arguments. That second run does not fetch or pull again."
      echo "Does not install or update Ollama. Does not overwrite .env, secrets, config, or library files."
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

never_touch_ollama_msg
cd "${ROOT}"
# Set means the parent already fetched, pulled, and decided to re-exec.
# Skip all three so this process cannot pull again and loop.
if [[ -z "${SUBWAVE_UPDATE_REEXEC:-}" ]]; then
  if [[ ${#ORIGINAL_ARGS[@]} -gt 0 ]]; then
    reexec_if_update_scripts_changed "${ROOT}" "${ORIGINAL_ARGS[@]}"
  else
    reexec_if_update_scripts_changed "${ROOT}"
  fi
fi

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
