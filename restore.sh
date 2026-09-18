#!/usr/bin/env bash
# Restore a backup created by backup.sh into the local clone directory named subwave-ai.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

ARCHIVE=""
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: ./restore.sh [--force] <backup.tar.gz>"
      echo "Extracts into the subwave-ai clone directory. Does not start Ollama or overwrite host services."
      exit 0
      ;;
    *)
      ARCHIVE="$1"
      shift
      ;;
  esac
done

[[ -n "${ARCHIVE}" ]] || die "pass a backup archive"
[[ -f "${ARCHIVE}" ]] || die "archive not found: ${ARCHIVE}"

if [[ "${FORCE}" -ne 1 && ( -f "${ROOT}/.env" || -f "${ROOT}/config/subwave.yaml" ) ]]; then
  die "existing config present; pass --force to extract over it"
fi

tar -tzf "${ARCHIVE}" >/dev/null
tar -xzf "${ARCHIVE}" -C "${ROOT}"
info "restored ${ARCHIVE} into the subwave-ai clone at ${ROOT}"
info "restart API/worker (./update.sh or systemctl restart subwave-api subwave-worker)"
info "Ollama was not modified."
