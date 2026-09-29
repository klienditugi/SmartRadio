# Shared helpers for Sub Wave AI ops scripts. Run from the local clone directory named subwave-ai.
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

# install.sh records the chosen mode here. update.sh trusts it, then falls back
# to unit files and the subwave-ai compose project. Gitignored. Not a secret.
install_mode_file() {
  printf '%s\n' "${1}/.subwave-install-mode"
}

write_install_mode() {
  local root="$1" mode="$2" file
  case "${mode}" in
    docker) mode="compose" ;;
    systemd|compose) ;;
    *) die "refusing to record install mode '${mode}'" ;;
  esac
  file="$(install_mode_file "${root}")"
  (umask 022; printf '%s\n' "${mode}" > "${file}")
}

# Prints systemd or compose. Returns 1 when the file is missing or unrecognized.
read_install_mode() {
  local root="$1" file mode
  file="$(install_mode_file "${root}")"
  [[ -f "${file}" ]] || return 1
  mode="$(tr -d '[:space:]' < "${file}")"
  case "${mode}" in
    systemd) printf '%s\n' systemd ;;
    compose|docker) printf '%s\n' compose ;;
    *) return 1 ;;
  esac
}

# True when the unit file is installed. No pipeline: list-unit-files piped to
# grep -q is unsafe under set -o pipefail. grep -q exits on the first match,
# the writer then dies with SIGPIPE (141), and pipefail makes the test false.
# Tests may set SUBWAVE_SYSTEMD_UNIT_DIRS to a colon-separated fixture path.
systemd_unit_loaded() {
  local unit="$1" dir state dirs
  dirs="${SUBWAVE_SYSTEMD_UNIT_DIRS:-/etc/systemd/system:/usr/lib/systemd/system:/lib/systemd/system}"
  while [[ -n "${dirs}" ]]; do
    dir="${dirs%%:*}"
    if [[ "${dirs}" == *:* ]]; then
      dirs="${dirs#*:}"
    else
      dirs=""
    fi
    [[ -n "${dir}" ]] || continue
    if [[ -f "${dir}/${unit}" || -L "${dir}/${unit}" ]]; then
      return 0
    fi
  done
  command -v systemctl >/dev/null 2>&1 || return 1
  state="$(systemctl_show_value LoadState "${unit}")"
  case "${state}" in
    loaded|masked) return 0 ;;
    *) return 1 ;;
  esac
}

systemctl_show_value() {
  local prop="$1"
  shift
  local raw=""
  command -v systemctl >/dev/null 2>&1 || return 0
  raw="$(systemctl show -p "${prop}" --value "$@" 2>/dev/null || true)"
  raw="${raw//$'\r'/}"
  raw="${raw//[[:space:]]/}"
  raw="${raw#"${prop}"=}"
  printf '%s\n' "${raw}"
}

# True only when a compose project named subwave-ai already exists.
# The compose file living in the repo is not an install. Another project's
# containers (smartradio-slskd) are not this app.
compose_project_present() {
  local name
  command -v docker >/dev/null 2>&1 || return 1
  while IFS= read -r name; do
    name="${name//$'\r'/}"
    if [[ "${name}" == "subwave-ai" ]]; then
      return 0
    fi
  done < <(docker compose ls -a --format '{{.Name}}' 2>/dev/null || true)
  return 1
}

# Prints systemd, compose, or none.
# Unit files win over a recorded compose mode and over Docker being installed.
resolve_deploy_mode() {
  local root="$1" recorded=""
  if [[ -f "$(install_mode_file "${root}")" ]]; then
    if recorded="$(read_install_mode "${root}")"; then
      :
    else
      warn "ignoring unrecognized $(install_mode_file "${root}")"
      recorded=""
    fi
  fi
  if systemd_unit_loaded subwave-api.service; then
    if [[ "${recorded}" == "compose" ]]; then
      warn "install mode file says compose, but subwave-api.service is installed. Staying on systemd. Compose will not be started."
    fi
    printf '%s\n' systemd
    return 0
  fi
  if [[ -n "${recorded}" ]]; then
    printf '%s\n' "${recorded}"
    return 0
  fi
  if compose_project_present; then
    printf '%s\n' compose
    return 0
  fi
  printf '%s\n' none
}

valid_tcp_port() {
  local p="$1"
  [[ "${p}" =~ ^[0-9]+$ ]] || return 1
  [[ "${p}" -ge 1 && "${p}" -le 65535 ]]
}

read_yaml_server_port() {
  local file="$1" port=""
  [[ -f "${file}" ]] || return 1
  port="$(awk '
    /^[[:space:]]*($|#)/ { next }
    /^server:[[:space:]]*(#.*)?$/ { in_server = 1; next }
    in_server && /^[^[:space:]#]/ { in_server = 0 }
    in_server && /^[[:space:]]+port:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]*port:[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      gsub(/[[:space:]]/, "", line)
      if (line ~ /^[0-9]+$/) { print line; exit }
      if (line ~ /^"[0-9]+"$/) { gsub(/"/, "", line); print line; exit }
      if (line ~ /^'\''[0-9]+'\''$/) { gsub(/'\''/, "", line); print line; exit }
    }
  ' "${file}")"
  [[ -n "${port}" ]] || return 1
  printf '%s\n' "${port}"
}

# Env wins over config, matching the API. Default 8788. Does not write config.
resolve_api_port() {
  local root="$1" port="" cfg
  if [[ -n "${SUBWAVE_API_PORT:-}" ]]; then
    port="${SUBWAVE_API_PORT//$'\r'/}"
    port="${port//[[:space:]]/}"
    valid_tcp_port "${port}" || die "SUBWAVE_API_PORT is not a TCP port: ${SUBWAVE_API_PORT}"
    printf '%s\n' "${port}"
    return 0
  fi
  cfg="${SUBWAVE_CONFIG:-${root}/config/subwave.yaml}"
  if [[ -f "${cfg}" ]]; then
    port="$(read_yaml_server_port "${cfg}" || true)"
    if [[ -n "${port}" ]]; then
      valid_tcp_port "${port}" || die "server.port in ${cfg} is not a TCP port: ${port}"
      printf '%s\n' "${port}"
      return 0
    fi
  fi
  printf '%s\n' 8788
}

pid_comm() {
  local pid="$1" comm=""
  if command -v ps >/dev/null 2>&1; then
    comm="$(ps -p "${pid}" -o comm= 2>/dev/null || true)"
  fi
  comm="${comm//$'\n'/}"
  comm="${comm#"${comm%%[![:space:]]*}"}"
  comm="${comm%"${comm##*[![:space:]]}"}"
  if [[ -z "${comm}" && -r "/proc/${pid}/comm" ]]; then
    comm="$(tr -d '\n' < "/proc/${pid}/comm" 2>/dev/null || true)"
  fi
  printf '%s\n' "${comm}"
}

describe_pid() {
  local pid="$1" comm="" cmd=""
  comm="$(pid_comm "${pid}")"
  [[ -n "${comm}" ]] || comm="unknown"
  if [[ -r "/proc/${pid}/cmdline" ]]; then
    cmd="$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)"
    cmd="${cmd%"${cmd##*[![:space:]]}"}"
  fi
  if [[ ${#cmd} -gt 180 ]]; then
    cmd="${cmd:0:180}..."
  fi
  if [[ -n "${cmd}" ]]; then
    printf 'pid %s (%s) [%s]' "${pid}" "${comm}" "${cmd}"
  else
    printf 'pid %s (%s)' "${pid}" "${comm}"
  fi
}

pid_belongs_to_systemd_unit() {
  local pid="$1" unit="$2" main="" cur="" ppid="" i
  if [[ -r "/proc/${pid}/cgroup" ]] && grep -F -- "${unit}" "/proc/${pid}/cgroup" >/dev/null 2>&1; then
    return 0
  fi
  main="$(systemctl_show_value MainPID "${unit}")"
  [[ -n "${main}" && "${main}" != "0" ]] || return 1
  cur="${pid}"
  for i in 1 2 3 4 5 6 7 8; do
    [[ -n "${cur}" && "${cur}" != "0" ]] || return 1
    if [[ "${cur}" == "${main}" ]]; then
      return 0
    fi
    if [[ "${cur}" == "1" ]]; then
      return 1
    fi
    [[ -r "/proc/${cur}/status" ]] || return 1
    ppid="$(awk '/^PPid:/ { print $2 }' "/proc/${cur}/status" 2>/dev/null || true)"
    [[ -n "${ppid}" ]] || return 1
    cur="${ppid}"
  done
  return 1
}

compose_api_publishes_port() {
  local port="$1" line
  command -v docker >/dev/null 2>&1 || return 1
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    if [[ "${line}" == *":${port}->"* ]]; then
      return 0
    fi
  done < <(docker ps --filter label=com.docker.compose.project=subwave-ai --filter label=com.docker.compose.service=api --format '{{.Names}} {{.Ports}}' 2>/dev/null || true)
  return 1
}

pid_belongs_to_compose_api() {
  local pid="$1" port="$2" comm="" cid="" cpid=""
  comm="$(pid_comm "${pid}")"
  case "${comm}" in
    docker-proxy|docker-proxy*|rootlesskit|rootlesskit*|containerd-shim|containerd-shim*)
      compose_api_publishes_port "${port}"
      return
      ;;
  esac
  if [[ -r "/proc/${pid}/cgroup" ]] && grep -Eq 'docker|containerd|libpod' "/proc/${pid}/cgroup"; then
    compose_api_publishes_port "${port}"
    return
  fi
  command -v docker >/dev/null 2>&1 || return 1
  local line=""
  cid=""
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    if [[ -z "${cid}" ]]; then
      cid="${line}"
    fi
  done < <(docker ps -q --filter label=com.docker.compose.project=subwave-ai --filter label=com.docker.compose.service=api --filter status=running 2>/dev/null || true)
  [[ -n "${cid}" ]] || return 1
  cpid="$(docker inspect -f '{{.State.Pid}}' "${cid}" 2>/dev/null || true)"
  cpid="${cpid//[[:space:]]/}"
  [[ -n "${cpid}" && "${cpid}" != "0" && "${cpid}" == "${pid}" ]]
}

pid_allowed_for_restart() {
  local mode="$1" pid="$2" port="$3"
  case "${mode}" in
    systemd) pid_belongs_to_systemd_unit "${pid}" subwave-api.service ;;
    compose) pid_belongs_to_compose_api "${pid}" "${port}" ;;
    *) return 1 ;;
  esac
}

# ss prints one listener line per socket. A failure falls back to /proc/net/tcp.
# Prints one pid per line, or "?" when the socket is visible but the process is not.
list_listener_pids_ss() {
  local port="$1" out="" line="" rest="" pid=""
  local -a pids=()
  if ! out="$(ss -H -ltnp sport = ":${port}" 2>/dev/null)"; then
    return 2
  fi
  [[ -n "${out}" ]] || return 0
  while IFS= read -r line; do
    [[ -n "${line}" ]] || continue
    [[ "${line}" == Netid* || "${line}" == State* ]] && continue
    if [[ ! "${line}" =~ (^|[^0-9])${port}([^0-9]|$) ]]; then
      continue
    fi
    rest="${line}"
    local found=1
    while [[ "${rest}" =~ pid=([0-9]+) ]]; do
      pid="${BASH_REMATCH[1]}"
      pids+=("${pid}")
      found=0
      rest="${rest#*pid=${pid}}"
    done
    if [[ "${found}" -eq 1 ]]; then
      pids+=("?")
    fi
  done <<< "${out}"
  if [[ ${#pids[@]} -eq 0 ]]; then
    return 2
  fi
  local p seen=" "
  for p in "${pids[@]}"; do
    case "${seen}" in
      *" ${p} "*) ;;
      *)
        seen+="${p} "
        printf '%s\n' "${p}"
        ;;
    esac
  done
}

list_listener_pids_proc() {
  local port="$1" hex="" inode="" inodes="" pid="" proc_dir="" fd="" target=""
  local want=" " seen=" "
  hex="$(printf '%04X' "${port}")"
  inodes="$(awk -v p="${hex}" 'FNR > 1 {
    split($2, a, ":")
    if (toupper(a[2]) == p && $4 == "0A" && $10 != "0") print $10
  }' /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
  [[ -n "${inodes}" ]] || return 0
  for inode in ${inodes}; do
    want+="${inode} "
  done
  local -A found=()
  for proc_dir in /proc/[0-9]*; do
    pid="${proc_dir#/proc/}"
    [[ "${pid}" =~ ^[0-9]+$ ]] || continue
    [[ -d "${proc_dir}/fd" ]] || continue
    for fd in "${proc_dir}/fd"/*; do
      target="$(readlink "${fd}" 2>/dev/null || true)"
      [[ "${target}" == socket:\[*\] ]] || continue
      inode="${target#socket:[}"
      inode="${inode%]}"
      case "${want}" in
        *" ${inode} "*) found["${pid}"]=1 ;;
      esac
    done
  done
  if [[ ${#found[@]} -eq 0 ]]; then
    printf '%s\n' '?'
    return 0
  fi
  for pid in "${!found[@]}"; do
    case "${seen}" in
      *" ${pid} "*) ;;
      *)
        seen+="${pid} "
        printf '%s\n' "${pid}"
        ;;
    esac
  done
}

list_listener_pids() {
  local port="$1" from_ss="" from_proc="" ec=0
  if command -v ss >/dev/null 2>&1; then
    from_ss="$(list_listener_pids_ss "${port}")" && ec=0 || ec=$?
    # A named pid from ss is enough. "?" means the socket is visible but the
    # process is not (common without root). /proc can still map the inode.
    if [[ "${ec}" -eq 0 && -n "${from_ss}" && "${from_ss}" != *"?"* ]]; then
      printf '%s\n' "${from_ss}"
      return 0
    fi
    if [[ "${ec}" -ne 0 || "${from_ss}" == *"?"* ]]; then
      from_proc="$(list_listener_pids_proc "${port}")"
      if [[ -n "${from_proc}" && "${from_proc}" != *"?"* ]]; then
        printf '%s\n' "${from_proc}"
        return 0
      fi
      if [[ "${ec}" -eq 0 && -n "${from_ss}" ]]; then
        printf '%s\n' "${from_ss}"
        return 0
      fi
      if [[ -n "${from_proc}" ]]; then
        printf '%s\n' "${from_proc}"
      fi
      return 0
    fi
    # ss ran and reported no listener.
    return 0
  fi
  list_listener_pids_proc "${port}"
}

assert_api_port_free_for() {
  local mode="$1" port="$2" root="$3" pid="" seen=" " desc="" comm="" hint=""
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    case "${seen}" in
      *" ${pid} "*) continue ;;
    esac
    seen+="${pid} "
    if [[ "${pid}" == "?" ]]; then
      # Non-root compose updates often cannot see docker-proxy's pid. A running
      # subwave-ai api container that publishes this port is the holder.
      if [[ "${mode}" == "compose" ]] && compose_api_publishes_port "${port}"; then
        continue
      fi
      die "API port ${port} is already in use, but the owning process could not be identified. Refusing to start or restart. Nothing was killed."
    fi
    if pid_allowed_for_restart "${mode}" "${pid}" "${port}"; then
      continue
    fi
    desc="$(describe_pid "${pid}")"
    comm="$(pid_comm "${pid}")"
    hint=""
    case "${comm}" in
      docker-proxy|docker-proxy*|rootlesskit|rootlesskit*|containerd-shim|containerd-shim*)
        hint=" Stop the subwave-ai project yourself if it is the listener: docker compose -f ${root}/deploy/docker-compose.yml -p subwave-ai down. This script did not stop it and does not touch smartradio-slskd."
        ;;
    esac
    die "API port ${port} is held by ${desc}. Refusing to start or restart. Nothing was killed.${hint}"
  done < <(list_listener_pids "${port}")
}

# Systemd installs only. Created/Exited containers are reported and left in
# place so their logs stay available. Running containers abort the update.
# Nothing is stopped, removed, or killed. Other compose projects are ignored.
note_leftover_compose_containers() {
  local root="$1" line="" name="" status="" running="" leftover=""
  command -v docker >/dev/null 2>&1 || return 0
  while IFS=$'\t' read -r name status; do
    name="${name//$'\r'/}"
    status="${status//$'\r'/}"
    [[ -n "${name}" ]] || continue
    case "${status}" in
      Up*|Restarting*|Paused*)
        running+="${name} (${status})"$'\n'
        ;;
      Created*|Exited*|Dead*)
        leftover+="${name} (${status})"$'\n'
        ;;
      *)
        running+="${name} (${status})"$'\n'
        ;;
    esac
  done < <(docker ps -a --filter label=com.docker.compose.project=subwave-ai --format '{{.Names}}\t{{.Status}}' 2>/dev/null || true)
  if [[ -n "${running}" ]]; then
    die "subwave-ai compose containers are still running on a systemd install:
${running}Refusing to restart systemd while they exist. Nothing was stopped or removed.
To remove only that project: docker compose -f ${root}/deploy/docker-compose.yml -p subwave-ai down
That does not touch smartradio-slskd."
  fi
  if [[ -n "${leftover}" ]]; then
    warn "leftover subwave-ai compose containers are not running and were not removed:
${leftover}Their logs are still available. To remove only stopped containers in that project:
  docker compose -f ${root}/deploy/docker-compose.yml -p subwave-ai rm -f
That does not touch smartradio-slskd."
  fi
}

api_health_url() {
  local root="$1" host="" port=""
  host="${SUBWAVE_API_HOST:-127.0.0.1}"
  host="${host//$'\r'/}"
  if [[ "${host}" == "0.0.0.0" || "${host}" == "::" || "${host}" == "[::]" ]]; then
    host="127.0.0.1"
  fi
  if [[ "${host}" == *:* && "${host}" != \[*\] ]]; then
    host="[${host}]"
  fi
  port="$(resolve_api_port "${root}")"
  printf 'http://%s:%s/api/v1/health\n' "${host}" "${port}"
}

wait_for_api_health() {
  local root="$1" url="" code="" i="" commit=""
  url="$(api_health_url "${root}")"
  command -v curl >/dev/null 2>&1 || die "curl is required to confirm /api/v1/health returned 200"
  for ((i = 1; i <= 45; i++)); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "${url}" 2>/dev/null || true)"
    if [[ "${code}" == "200" ]]; then
      info "/api/v1/health returned 200 (${url})"
      return 0
    fi
    sleep 1
  done
  commit="$(git -C "${root}" rev-parse --short HEAD 2>/dev/null || true)"
  die "/api/v1/health did not return 200 at ${url} after restart (commit ${commit:-unknown}). Check journalctl -u subwave-api. Nothing was killed."
}

print_deployed_commit() {
  local root="$1" commit=""
  commit="$(git -C "${root}" rev-parse HEAD 2>/dev/null || true)"
  [[ -n "${commit}" ]] || die "could not read the deployed commit (git rev-parse HEAD)"
  info "deployed commit ${commit}"
}

restart_systemd_units() {
  local root="$1"
  if ! systemd_unit_loaded subwave-api.service || ! systemd_unit_loaded subwave-worker.service; then
    die "install mode is systemd, but subwave-api.service and subwave-worker.service are not both installed. Refusing to start Docker Compose."
  fi
  info "restarting systemd units subwave-api.service and subwave-worker.service"
  systemctl restart subwave-api.service subwave-worker.service
  systemctl is-active --quiet subwave-api.service || die "subwave-api.service is not active after restart"
  systemctl is-active --quiet subwave-worker.service || die "subwave-worker.service is not active after restart"
  info "subwave-api.service and subwave-worker.service are active"
  write_install_mode "${root}" systemd
  wait_for_api_health "${root}"
  print_deployed_commit "${root}"
}

restart_compose_project() {
  local root="$1" file="${root}/deploy/docker-compose.yml"
  command -v docker >/dev/null 2>&1 || die "install mode is compose, but docker is not available. Refusing to start systemd units."
  [[ -f "${file}" ]] || die "deploy/docker-compose.yml is missing. Refusing to start systemd units."
  [[ -f "${root}/.env" ]] || die "compose install requires ${root}/.env. Refusing to invent or overwrite it."
  if systemd_unit_loaded subwave-api.service; then
    die "refusing to start compose while subwave-api.service is installed"
  fi
  info "updating compose project subwave-ai"
  docker compose -f "${file}" -p subwave-ai --env-file "${root}/.env" up -d --build
  write_install_mode "${root}" compose
  wait_for_api_health "${root}"
  print_deployed_commit "${root}"
}

# Restarts the install that is already there. Never starts the other mode.
restart_managed_services() {
  local root="$1" mode="" port=""
  mode="$(resolve_deploy_mode "${root}")"
  case "${mode}" in
    systemd)
      if ! is_root; then
        die "systemd install detected. Re-run with sudo: sudo ./update.sh"
      fi
      port="$(resolve_api_port "${root}")"
      assert_api_port_free_for systemd "${port}" "${root}"
      note_leftover_compose_containers "${root}"
      restart_systemd_units "${root}"
      ;;
    compose)
      port="$(resolve_api_port "${root}")"
      assert_api_port_free_for compose "${port}" "${root}"
      restart_compose_project "${root}"
      ;;
    none)
      info "no managed services detected (no systemd units, no recorded install mode, no subwave-ai compose project). Start with pnpm dev:api / pnpm dev:worker"
      ;;
    *)
      die "unknown deploy mode: ${mode}"
      ;;
  esac
}
