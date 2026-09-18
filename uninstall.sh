#!/usr/bin/env bash
# Stop Sub Wave AI services. Default keeps data/library/secrets.
# Does not uninstall or stop Ollama or any unrelated host service.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

PURGE=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help)
      echo "Usage: ./uninstall.sh [--purge] [--force]"
      echo "Stops and disables subwave-api/worker (systemd) or the compose project."
      echo "Does not modify Ollama. --purge deletes this clone's data/secrets/.env after confirm."
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

if command -v systemctl >/dev/null 2>&1; then
  if is_root; then
    for unit in subwave-api subwave-worker; do
      if systemctl list-unit-files | grep -q "^${unit}.service"; then
        systemctl disable --now "${unit}.service" || true
        if [[ "${FORCE}" -eq 1 && -f "/etc/systemd/system/${unit}.service" ]]; then
          rm -f "/etc/systemd/system/${unit}.service"
        fi
        info "stopped ${unit}"
      fi
    done
    systemctl daemon-reload || true
  else
    warn "not root; cannot disable systemd units"
  fi
fi

if command -v docker >/dev/null 2>&1 && [[ -f "${ROOT}/deploy/docker-compose.yml" ]]; then
  if docker compose ls >/dev/null 2>&1; then
    docker compose -f "${ROOT}/deploy/docker-compose.yml" --env-file "${ROOT}/.env" down || true
  fi
fi

if [[ "${PURGE}" -eq 1 ]]; then
  if [[ "${FORCE}" -ne 1 ]]; then
    die "refusing --purge without --force (would delete data/secrets/.env in this clone)"
  fi
  warn "removing ${ROOT}/data ${ROOT}/secrets ${ROOT}/.env ${ROOT}/config/subwave.yaml"
  rm -rf "${ROOT}/data"
  rm -f "${ROOT}/.env" "${ROOT}/config/subwave.yaml"
  find "${ROOT}/secrets" -type f ! -name README.md ! -name .gitkeep -delete 2>/dev/null || true
fi

info "uninstall complete. Music library host path was not deleted unless it lived under ${ROOT}/data."
info "Ollama was not modified."
