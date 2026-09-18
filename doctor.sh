#!/usr/bin/env bash
# Health diagnostics for Sub Wave AI. Complements GET /api/v1/doctor.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

if [[ -f "${ROOT}/.env" ]]; then
  load_env_file "${ROOT}/.env"
fi

never_touch_ollama_msg
detect_os >/dev/null
check_resources "${ROOT}"

fail=0
check() {
  local name="$1"
  shift
  if "$@"; then
    echo "ok   ${name}"
  else
    echo "FAIL ${name}"
    fail=1
  fi
}

check "node>=20" bash -c 'command -v node >/dev/null && [[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 20 ]]'
check "pnpm" command -v pnpm >/dev/null
check "config yaml or example" bash -c '[[ -f "${SUBWAVE_CONFIG:-'"${ROOT}"'/config/subwave.yaml}" || -f "'"${ROOT}"'/config/subwave.example.yaml" ]]'
check "secrets dir" bash -c '[[ -d "${SUBWAVE_SECRETS_DIR:-'"${ROOT}"'/secrets}" ]]'

host="${SUBWAVE_API_HOST:-127.0.0.1}"
port="${SUBWAVE_API_PORT:-8788}"
if [[ "${host}" == "0.0.0.0" ]]; then host="127.0.0.1"; fi
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "http://${host}:${port}/api/v1/health" >/dev/null 2>&1; then
    echo "ok   api /health"
    curl -fsS "http://${host}:${port}/api/v1/doctor" || true
    echo
  else
    echo "FAIL api /health (is the API running on ${host}:${port}?)"
    fail=1
  fi
else
  echo "skip curl not installed"
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl is-active subwave-api.service >/dev/null 2>&1 && echo "ok   systemd subwave-api" || echo "skip systemd subwave-api inactive"
  systemctl is-active subwave-worker.service >/dev/null 2>&1 && echo "ok   systemd subwave-worker" || echo "skip systemd subwave-worker inactive"
fi

echo
echo "Persistent paths:"
echo "  library    ${SUBWAVE_LIBRARY_DIR:-${ROOT}/data/library}"
echo "  downloads  ${SUBWAVE_DOWNLOADS_DIR:-${ROOT}/data/downloads}"
echo "  staging    ${SUBWAVE_STAGING_DIR:-${ROOT}/data/staging}"
echo "  db         ${SUBWAVE_DB_PATH:-${ROOT}/data/subwave.sqlite}"
df -h "${SUBWAVE_LIBRARY_DIR:-${ROOT}}" "${SUBWAVE_DOWNLOADS_DIR:-${ROOT}}" 2>/dev/null || df -h "${ROOT}"

print_web_url
exit "${fail}"
