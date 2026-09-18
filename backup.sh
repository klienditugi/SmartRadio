#!/usr/bin/env bash
# Backup config, secrets, SQLite, and optionally the music library.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

INCLUDE_LIBRARY=0
OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --include-library) INCLUDE_LIBRARY=1; shift ;;
    --output) OUT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ./backup.sh [--output FILE] [--include-library]"
      echo "Archives .env, config yaml, secrets, SQLite, and path metadata."
      echo "Library files are omitted unless --include-library (can be large)."
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [[ -f "${ROOT}/.env" ]]; then
  load_env_file "${ROOT}/.env"
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-${ROOT}/backups/subwave-backup-${STAMP}.tar.gz}"
mkdir -p "$(dirname "${OUT}")" "${ROOT}/backups"

LIST=()
[[ -f "${ROOT}/.env" ]] && LIST+=(".env")
[[ -f "${ROOT}/config/subwave.yaml" ]] && LIST+=("config/subwave.yaml")
[[ -d "${ROOT}/secrets" ]] && LIST+=("secrets")
if [[ -n "${SUBWAVE_DB_PATH:-}" && -f "${SUBWAVE_DB_PATH}" ]]; then
  mkdir -p "${ROOT}/backups/staging"
  cp -a "${SUBWAVE_DB_PATH}" "${ROOT}/backups/staging/subwave.sqlite"
  LIST+=("backups/staging/subwave.sqlite")
elif [[ -f "${ROOT}/data/subwave.sqlite" ]]; then
  LIST+=("data/subwave.sqlite")
fi

if [[ "${INCLUDE_LIBRARY}" -eq 1 ]]; then
  lib="${SUBWAVE_LIBRARY_DIR:-${ROOT}/data/library}"
  if [[ -d "${lib}" ]]; then
    case "${lib}" in
      "${ROOT}"/*)
        LIST+=("${lib#${ROOT}/}")
        ;;
      *)
        warn "library ${lib} is outside the clone; not packed (copy it separately). SQLite/config/secrets are still in the archive."
        ;;
    esac
  fi
fi

(cd "${ROOT}" && tar -czf "${OUT}" "${LIST[@]}")
info "wrote ${OUT}"
info "Ollama was not included (external)."
