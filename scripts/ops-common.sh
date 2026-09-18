# Shared helpers for Sub Wave AI ops scripts.
# Ollama is EXTERNAL. These scripts must never install, update, pull, or manage it.

SUBWAVE_OPS_LOADED=1

ops_root() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  # When sourced from repo-root scripts, here is the repo root.
  # When sourced from scripts/, parent is the repo root.
  if [[ -f "${here}/pnpm-workspace.yaml" ]]; then
    printf '%s\n' "${here}"
  else
    printf '%s\n' "$(cd "${here}/.." && pwd)"
  fi
}

die() {
  echo "error: $*" >&2
  exit 1
}

info() { echo "==> $*"; }
warn() { echo "warning: $*" >&2; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

is_root() { [[ "$(id -u)" -eq 0 ]]; }

detect_os() {
  local uname_s uname_m
  uname_s="$(uname -s)"
  uname_m="$(uname -m)"
  [[ "${uname_s}" == "Linux" ]] || die "install.sh supports Linux only (found ${uname_s})"
  case "${uname_m}" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "unsupported architecture: ${uname_m}" ;;
  esac
  echo "${uname_s} ${uname_m}"
}

mem_kb() {
  awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0
}

check_resources() {
  local kb disk_kb
  kb="$(mem_kb)"
  if [[ "${kb}" -gt 0 && "${kb}" -lt 900000 ]]; then
    warn "less than ~1 GiB RAM detected (${kb} kB). The API+worker may be tight."
  fi
  disk_kb="$(df -Pk "${1:-.}" | awk 'NR==2 {print $4}')"
  if [[ "${disk_kb}" -gt 0 && "${disk_kb}" -lt 1048576 ]]; then
    warn "less than ~1 GiB free on ${1:-.} (${disk_kb} kB)."
  fi
}

assert_not_ollama_install() {
  # Guard against accidental package manager calls in this project.
  if [[ "${1:-}" == *ollama* ]]; then
    die "refusing to install or modify Ollama. Configure OLLAMA_BASE_URL and OLLAMA_MODEL only."
  fi
}

load_env_file() {
  local file="$1"
  if [[ -f "${file}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${file}"
    set +a
  fi
}

print_web_url() {
  local host="${SUBWAVE_API_HOST:-127.0.0.1}"
  local port="${SUBWAVE_API_PORT:-8788}"
  if [[ "${host}" == "0.0.0.0" || "${host}" == "::" ]]; then
    host="127.0.0.1"
  fi
  echo "Web UI: http://${host}:${port}/"
  echo "API:    http://${host}:${port}/api/v1/health"
  echo "Docs:   http://${host}:${port}/api/v1/docs"
}

never_touch_ollama_msg() {
  cat <<'EOF'
Ollama is an EXTERNAL service. This project never installs, updates, or pulls
Ollama or any model (including Qwen). Set OLLAMA_BASE_URL and OLLAMA_MODEL to a
daemon and model that already exist on your network.
EOF
}
