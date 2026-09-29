#!/usr/bin/env bash
# Behavioral tests for update mode selection.
# Stubs systemctl, docker, ss, curl, and id. Does not touch a real install,
# Ollama, slskd, or the API port.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/scripts/ops-common.sh"

ORIG_PATH="${PATH}"
REAL_PS="$(PATH="${ORIG_PATH}" command -v ps)"
WORK="$(mktemp -d)"
CASE=""
pass=0
fail=0
LAST_OUT=""
LAST_ERR=""

cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1" >&2; }

dump_case() {
  echo "----- stdout -----" >&2
  printf '%s\n' "${LAST_OUT}" >&2
  echo "----- stderr -----" >&2
  printf '%s\n' "${LAST_ERR}" >&2
  echo "----- systemctl -----" >&2
  cat "${SYSTEMCTL_LOG}" >&2 || true
  echo "----- docker -----" >&2
  cat "${DOCKER_LOG}" >&2 || true
}

prepare_case() {
  CASE="${WORK}/case"
  rm -rf "${CASE}"
  mkdir -p "${CASE}/bin" "${CASE}/units" "${CASE}/repo/deploy" "${CASE}/repo/config"
  export SYSTEMCTL_LOG="${CASE}/systemctl.log"
  export DOCKER_LOG="${CASE}/docker.log"
  export KILL_LOG="${CASE}/kill.log"
  export CURL_LOG="${CASE}/curl.log"
  : > "${SYSTEMCTL_LOG}"
  : > "${DOCKER_LOG}"
  : > "${KILL_LOG}"
  : > "${CURL_LOG}"

  cat > "${CASE}/bin/systemctl" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${SYSTEMCTL_LOG}"
case "${1:-}" in
  list-unit-files)
    queried=""
    for arg in "$@"; do
      case "${arg}" in
        *.service) queried="${arg}" ;;
      esac
    done
    if [[ -n "${queried}" ]]; then
      # Pipe-free query of one unit. Must not flood, or the old SIGPIPE test
      # and this path would be the same command.
      if [[ -n "${SYSTEMCTL_LIST_FAIL:-}" ]]; then
        exit 141
      fi
      case "${SYSTEMCTL_LOAD_STATE:-not-found}" in
        loaded|masked)
          case "${queried}" in
            subwave-api.service|subwave-worker.service)
              printf '%s %s enabled\n' "${queried}" "${SYSTEMCTL_LOAD_STATE}"
              ;;
          esac
          ;;
      esac
      exit 0
    fi
    printf '%s\n' "subwave-api.service enabled enabled"
    printf '%s\n' "subwave-worker.service enabled enabled"
    i=0
    while [[ "${i}" -lt 20000 ]]; do
      printf 'unit-%05d.service disabled disabled\n' "${i}"
      i=$((i + 1))
    done
    exit 0
    ;;
  show)
    if [[ -n "${SYSTEMCTL_SHOW_FAIL:-}" ]]; then
      exit 141
    fi
    if [[ "$*" == *LoadState* ]]; then
      printf '%s\n' "${SYSTEMCTL_LOAD_STATE:-not-found}"
      exit 0
    fi
    if [[ "$*" == *MainPID* ]]; then
      printf '%s\n' "${SYSTEMCTL_MAIN_PID:-0}"
      exit 0
    fi
    exit 0
    ;;
  restart)
    exit 0
    ;;
  is-active)
    if [[ "${SYSTEMCTL_IS_ACTIVE:-active}" == "active" ]]; then
      exit 0
    fi
    exit 3
    ;;
  *)
    exit 1
    ;;
esac
EOF

  cat > "${CASE}/bin/docker" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${DOCKER_LOG}"
if [[ "${1:-}" == "compose" && "${2:-}" == "ls" ]]; then
  if [[ -n "${DOCKER_COMPOSE_LS:-}" ]]; then
    printf '%s\n' "${DOCKER_COMPOSE_LS}"
  fi
  exit 0
fi
if [[ "${1:-}" == "ps" ]]; then
  if [[ -n "${DOCKER_PS_OUT:-}" ]]; then
    printf '%s\n' "${DOCKER_PS_OUT}"
  fi
  exit 0
fi
if [[ "${1:-}" == "inspect" ]]; then
  printf '%s\n' "${DOCKER_INSPECT_PID:-0}"
  exit 0
fi
exit 0
EOF

  cat > "${CASE}/bin/ss" << 'EOF'
#!/usr/bin/env bash
if [[ -n "${SS_FAIL:-}" ]]; then
  echo "ss failed" >&2
  exit 1
fi
if [[ -n "${SS_OUTPUT:-}" ]]; then
  printf '%s\n' "${SS_OUTPUT}"
fi
exit 0
EOF

  cat > "${CASE}/bin/curl" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "${CURL_CODE:-200}"
exit 0
EOF

  cat > "${CASE}/bin/id" << 'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-u" ]]; then
  printf '%s\n' "${STUB_UID:-0}"
  exit 0
fi
printf '%s\n' "${STUB_UID:-0}"
exit 0
EOF

  cat > "${CASE}/bin/kill" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${KILL_LOG}"
exit 99
EOF

  cat > "${CASE}/bin/ps" << EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "-p" && -n "\${PS_COMM_FOR_PID:-}" && "\${2:-}" == "\${PS_COMM_PID:-}" ]]; then
  printf '%s\n' "\${PS_COMM_FOR_PID}"
  exit 0
fi
exec ${REAL_PS} "\$@"
EOF

  chmod +x "${CASE}/bin/"*

  git -C "${CASE}/repo" init -q
  git -C "${CASE}/repo" config user.email "ops-test@example.com"
  git -C "${CASE}/repo" config user.name "ops-test"
  git -C "${CASE}/repo" config commit.gpgsign false
  printf 'init\n' > "${CASE}/repo/README"
  printf 'name: subwave-ai\n' > "${CASE}/repo/deploy/docker-compose.yml"
  printf 'SUBWAVE_API_PORT=8788\n' > "${CASE}/repo/.env"
  git -C "${CASE}/repo" add README deploy/docker-compose.yml
  git -C "${CASE}/repo" commit -qm init

  export PATH="${CASE}/bin:${ORIG_PATH}"
  export SUBWAVE_SYSTEMD_UNIT_DIRS="${CASE}/units"
  export SUBWAVE_API_PORT=54321
  export STUB_UID=0
  export SYSTEMCTL_LOAD_STATE=not-found
  export SYSTEMCTL_MAIN_PID=0
  export SYSTEMCTL_IS_ACTIVE=active
  unset SUBWAVE_API_HOST SUBWAVE_CONFIG SS_OUTPUT SS_FAIL DOCKER_COMPOSE_LS DOCKER_PS_OUT DOCKER_INSPECT_PID PS_COMM_FOR_PID PS_COMM_PID SYSTEMCTL_SHOW_FAIL CURL_CODE || true
}

run_scenario() {
  local name="$1" expect="$2"
  shift 2
  local out err ec
  out="$(mktemp)"
  err="$(mktemp)"
  set +e
  (
    set -euo pipefail
    "$@"
  ) >"${out}" 2>"${err}"
  ec=$?
  set -e
  LAST_OUT="$(cat "${out}")"
  LAST_ERR="$(cat "${err}")"
  rm -f "${out}" "${err}"
  if [[ "${expect}" == "ok" && "${ec}" -eq 0 ]]; then
    ok "${name}"
  elif [[ "${expect}" == "fail" && "${ec}" -ne 0 ]]; then
    ok "${name}"
  else
    bad "${name} (exit ${ec}, expected ${expect})"
    dump_case
  fi
}

assert_out_has() {
  local name="$1" needle="$2"
  case "${LAST_OUT}" in
    *"${needle}"*) ok "${name}" ;;
    *) bad "${name}"; dump_case ;;
  esac
}

assert_err_has() {
  local name="$1" needle="$2"
  case "${LAST_ERR}" in
    *"${needle}"*) ok "${name}" ;;
    *) bad "${name}"; dump_case ;;
  esac
}

assert_log_lacks() {
  local name="$1" file="$2" needle="$3"
  if [[ -f "${file}" ]] && grep -F -- "${needle}" "${file}" >/dev/null 2>&1; then
    bad "${name}"
    dump_case
  else
    ok "${name}"
  fi
}

assert_log_has() {
  local name="$1" file="$2" needle="$3"
  if [[ -f "${file}" ]] && grep -F -- "${needle}" "${file}" >/dev/null 2>&1; then
    ok "${name}"
  else
    bad "${name}"
    dump_case
  fi
}

install_unit_files() {
  printf '[Unit]\nDescription=api\n' > "${CASE}/units/subwave-api.service"
  printf '[Unit]\nDescription=worker\n' > "${CASE}/units/subwave-worker.service"
}

scenario_pipefail_fixed() {
  # No unit files on disk. Detection has to succeed from systemctl alone.
  export SYSTEMCTL_LOAD_STATE=loaded
  local with_pipefail=0 without=0 targeted=0 targeted_out=""
  set +e
  set -o pipefail
  systemctl list-unit-files | grep -q '^subwave-api.service'
  with_pipefail=$?
  set +o pipefail
  systemctl list-unit-files | grep -q '^subwave-api.service'
  without=$?
  set -o pipefail
  targeted_out="$(systemctl list-unit-files --no-legend --no-pager subwave-api.service 2>/dev/null)"
  targeted=$?
  set -e
  if [[ "${with_pipefail}" -ne 141 ]]; then
    echo "expected SIGPIPE fall-through (141) from list-unit-files piped to grep -q, got ${with_pipefail}" >&2
    return 1
  fi
  if [[ "${without}" -ne 0 ]]; then
    echo "without pipefail the same pipeline should succeed because the unit is present, got ${without}" >&2
    return 1
  fi
  if [[ "${targeted}" -ne 0 || "${targeted_out}" != subwave-api.service* ]]; then
    echo "pipe-free list-unit-files subwave-api.service failed: status ${targeted} output [${targeted_out}]" >&2
    return 1
  fi
  systemd_unit_loaded subwave-api.service
  : > "${SYSTEMCTL_LOG}"
  : > "${DOCKER_LOG}"
  export DOCKER_COMPOSE_LS=smartradio-slskd
  restart_managed_services "${CASE}/repo"
}

scenario_show_sigpipe_still_systemd() {
  install_unit_files
  export SYSTEMCTL_LIST_FAIL=1
  export DOCKER_COMPOSE_LS=subwave-ai
  mode="$(resolve_deploy_mode "${CASE}/repo")"
  [[ "${mode}" == "systemd" ]]
}

scenario_not_root() {
  install_unit_files
  export STUB_UID=1000
  export DOCKER_COMPOSE_LS=subwave-ai
  restart_managed_services "${CASE}/repo"
}

scenario_docker_without_project() {
  export DOCKER_COMPOSE_LS=smartradio-slskd
  restart_managed_services "${CASE}/repo"
}

scenario_recorded_systemd_without_units() {
  write_install_mode "${CASE}/repo" systemd
  export DOCKER_COMPOSE_LS=subwave-ai
  restart_managed_services "${CASE}/repo"
}

scenario_compose_project() {
  export DOCKER_COMPOSE_LS=subwave-ai
  restart_managed_services "${CASE}/repo"
}

scenario_port_held() {
  install_unit_files
  export SYSTEMCTL_MAIN_PID=99999
  export SS_OUTPUT='LISTEN 0 128 127.0.0.1:54321 0.0.0.0:* users:(("intruder",pid=1,fd=4))'
  restart_managed_services "${CASE}/repo"
}

scenario_port_owned_by_unit() {
  install_unit_files
  export SYSTEMCTL_MAIN_PID=4242
  export SS_OUTPUT='LISTEN 0 128 127.0.0.1:54321 0.0.0.0:* users:(("node",pid=4242,fd=18))'
  restart_managed_services "${CASE}/repo"
}

scenario_exited_containers() {
  install_unit_files
  export DOCKER_PS_OUT="$(printf '%s\t%s\n%s\t%s' 'subwave-ai-api-1' 'Exited (1) 2 hours ago' 'subwave-ai-worker-1' 'Created')"
  restart_managed_services "${CASE}/repo"
}

scenario_running_containers() {
  install_unit_files
  export DOCKER_PS_OUT="$(printf '%s\t%s' 'subwave-ai-api-1' 'Up 3 seconds')"
  restart_managed_services "${CASE}/repo"
}

scenario_compose_unnamed_port_owner() {
  export DOCKER_COMPOSE_LS=subwave-ai
  export SS_OUTPUT='LISTEN 0 128 0.0.0.0:54321 0.0.0.0:*'
  export DOCKER_PS_OUT='subwave-ai-api-1 0.0.0.0:54321->8788/tcp'
  restart_managed_services "${CASE}/repo"
}

scenario_unnamed_port_owner_blocks_systemd() {
  install_unit_files
  export SS_OUTPUT='LISTEN 0 128 127.0.0.1:54321 0.0.0.0:*'
  restart_managed_services "${CASE}/repo"
}

scenario_compose_owns_port() {
  export DOCKER_COMPOSE_LS=subwave-ai
  export PS_COMM_PID=4242
  export PS_COMM_FOR_PID=docker-proxy
  export SS_OUTPUT='LISTEN 0 128 0.0.0.0:54321 0.0.0.0:* users:(("docker-proxy",pid=4242,fd=4))'
  export DOCKER_PS_OUT='subwave-ai-api-1 0.0.0.0:54321->8788/tcp'
  restart_managed_services "${CASE}/repo"
}

scenario_units_override_recorded_compose() {
  install_unit_files
  write_install_mode "${CASE}/repo" compose
  export DOCKER_COMPOSE_LS=subwave-ai
  restart_managed_services "${CASE}/repo"
}

scenario_inactive_after_restart() {
  install_unit_files
  export SYSTEMCTL_IS_ACTIVE=inactive
  restart_managed_services "${CASE}/repo"
}

scenario_yaml_port() {
  unset SUBWAVE_API_PORT
  cat > "${CASE}/repo/config/subwave.yaml" << 'EOF'
server:
  host: "127.0.0.1"
  port: 8791
slskd:
  port: 5030
EOF
  [[ "$(resolve_api_port "${CASE}/repo")" == "8791" ]]
  printf 'server:\n  port: "8794"\n' > "${CASE}/repo/config/subwave.yaml"
  [[ "$(resolve_api_port "${CASE}/repo")" == "8794" ]]
  export SUBWAVE_API_PORT=6001
  [[ "$(resolve_api_port "${CASE}/repo")" == "6001" ]]
  unset SUBWAVE_API_PORT
  rm -f "${CASE}/repo/config/subwave.yaml"
  unset SUBWAVE_CONFIG
  [[ "$(resolve_api_port "${CASE}/repo")" == "8788" ]]
}

scenario_proc_fallback_quiet() {
  export PATH="${ORIG_PATH}"
  local pids
  pids="$(list_listener_pids 1)"
  [[ -z "${pids}" ]]
  pids="$(list_listener_pids 65432)"
  [[ -z "${pids}" ]]
}

write_owner_stubs() {
  local owner="$1"
  export CHOWN_LOG="${CASE}/chown.log"
  export RUNUSER_LOG="${CASE}/runuser.log"
  export PNPM_LOG="${CASE}/pnpm.log"
  : > "${CHOWN_LOG}"
  : > "${RUNUSER_LOG}"
  : > "${PNPM_LOG}"
  cat > "${CASE}/bin/stat" << EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "-c" ]]; then
  case "\${2:-}" in
    %U) printf '%s\n' '${owner}'; exit 0 ;;
    %G) printf '%s\n' '${owner}'; exit 0 ;;
  esac
fi
exit 1
EOF
  cat > "${CASE}/bin/chown" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CHOWN_LOG}"
exit 0
EOF
  cat > "${CASE}/bin/runuser" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${RUNUSER_LOG}"
exit 0
EOF
  cat > "${CASE}/bin/sudo" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${RUNUSER_LOG}"
exit 0
EOF
  cat > "${CASE}/bin/pnpm" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${PNPM_LOG}"
exit 0
EOF
  cat > "${CASE}/bin/node" << 'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat > "${CASE}/bin/getent" << EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "passwd" && "\${2:-}" == "${owner}" ]]; then
  printf '%s\n' '${owner}:x:1001:1001:Owner:/home/${owner}:/bin/bash'
  exit 0
fi
exit 2
EOF
  chmod +x "${CASE}/bin/stat" "${CASE}/bin/chown" "${CASE}/bin/runuser" "${CASE}/bin/sudo" "${CASE}/bin/pnpm" "${CASE}/bin/node" "${CASE}/bin/getent"
}

write_git_stub() {
  export GIT_LOG="${CASE}/git.log"
  : > "${GIT_LOG}"
  cat > "${CASE}/bin/git" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GIT_LOG}"
if [[ "$*" == *rev-parse* ]]; then
  printf '%s\n' main
fi
exit 0
EOF
  chmod +x "${CASE}/bin/git"
}

scenario_git_as_repo_owner() {
  export STUB_UID=0
  write_owner_stubs grokbot
  write_git_stub
  mkdir -p "${CASE}/repo/.git" "${CASE}/repo/secrets" "${CASE}/repo/data" "${CASE}/repo/config"
  printf 'x\n' > "${CASE}/repo/.env"
  printf 'x\n' > "${CASE}/repo/secrets/verification_hmac_key"
  printf 'x\n' > "${CASE}/repo/config/subwave.yaml"
  printf 'x\n' > "${CASE}/repo/data/subwave.sqlite"
  update_git_checkout "${CASE}/repo"
}

scenario_git_not_root() {
  export STUB_UID=1000
  write_owner_stubs grokbot
  write_git_stub
  mkdir -p "${CASE}/repo/.git"
  update_git_checkout "${CASE}/repo"
}

scenario_build_as_repo_owner() {
  export STUB_UID=0
  write_owner_stubs grokbot
  mkdir -p "${CASE}/repo/node_modules" "${CASE}/repo/apps/web/dist" "${CASE}/repo/apps/api/node_modules" "${CASE}/repo/packages/core/node_modules" "${CASE}/repo/secrets" "${CASE}/repo/data" "${CASE}/repo/config"
  printf 'x\n' > "${CASE}/repo/secrets/verification_hmac_key"
  printf 'x\n' > "${CASE}/repo/.env"
  printf 'x\n' > "${CASE}/repo/config/subwave.yaml"
  printf 'x\n' > "${CASE}/repo/data/subwave.sqlite"
  run_project_js_build "${CASE}/repo"
}

scenario_build_not_root() {
  export STUB_UID=1000
  write_owner_stubs grokbot
  mkdir -p "${CASE}/repo/node_modules" "${CASE}/repo/apps/web/dist"
  run_project_js_build "${CASE}/repo"
}

scenario_ss_failure_uses_proc() {
  export SS_FAIL=1
  export PATH="${CASE}/bin:${ORIG_PATH}"
  local pids
  pids="$(list_listener_pids 65432)"
  [[ -z "${pids}" ]]
}

bash -n "${ROOT}/install.sh" "${ROOT}/update.sh" "${ROOT}/uninstall.sh" "${ROOT}/scripts/ops-common.sh" "${ROOT}/scripts/test-update-mode.sh"
ok "bash -n ops scripts"

if grep -nE 'list-unit-files[[:space:]]*\|' "${ROOT}/update.sh" "${ROOT}/uninstall.sh" "${ROOT}/scripts/ops-common.sh"; then
  bad "systemd detection still pipes list-unit-files"
else
  ok "systemd detection does not pipe list-unit-files"
fi
grep -q 'list-unit-files --no-legend --no-pager' "${ROOT}/scripts/ops-common.sh"
ok "detection queries one unit without grep"

grep -q 'restart_managed_services' "${ROOT}/update.sh"
ok "update.sh restarts through restart_managed_services"
grep -q 'SIGPIPE' "${ROOT}/scripts/ops-common.sh"
ok "ops-common documents the SIGPIPE failure"
grep -q 'write_install_mode' "${ROOT}/install.sh"
ok "install.sh records the install mode"
grep -q 'update_git_checkout' "${ROOT}/update.sh"
ok "update.sh pulls through update_git_checkout"
if grep -nE '^[[:space:]]*git (fetch|pull|checkout|reset|submodule)' "${ROOT}/update.sh"; then
  bad "update.sh still runs a git write directly"
else
  ok "update.sh does not run git fetch/pull directly"
fi
git -C "${ROOT}" check-ignore -q .subwave-install-mode
ok "install mode file is gitignored"

prepare_case
run_scenario "pipefail fall-through is fixed" ok scenario_pipefail_fixed
commit="$(git -C "${CASE}/repo" rev-parse HEAD)"
assert_out_has "prints deployed commit" "deployed commit ${commit}"
assert_out_has "health is 200" "/api/v1/health returned 200"
assert_log_has "restarts both units" "${SYSTEMCTL_LOG}" "restart subwave-api.service subwave-worker.service"
assert_log_has "queries subwave-api.service directly" "${SYSTEMCTL_LOG}" "list-unit-files --no-legend --no-pager subwave-api.service"
assert_log_lacks "restart does not dump every unit" "${SYSTEMCTL_LOG}" "unit-00000.service"
assert_log_lacks "does not compose up" "${DOCKER_LOG}" " up "
assert_log_lacks "does not mention slskd to docker" "${DOCKER_LOG}" "smartradio-slskd"
[[ "$(tr -d '[:space:]' < "$(install_mode_file "${CASE}/repo")")" == "systemd" ]] && ok "records systemd after restart" || bad "records systemd after restart"
[[ ! -s "${KILL_LOG}" ]] && ok "pipefail case kills nothing" || bad "pipefail case kills nothing"

prepare_case
run_scenario "unit files win when systemctl show dies" ok scenario_show_sigpipe_still_systemd
assert_log_lacks "show failure does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "non-root systemd update fails" fail scenario_not_root
assert_err_has "non-root tells you to re-run with sudo" "sudo ./update.sh"
assert_log_lacks "non-root does not restart" "${SYSTEMCTL_LOG}" "restart "
assert_log_lacks "non-root does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "docker without a subwave-ai project stays unmanaged" ok scenario_docker_without_project
assert_out_has "unmanaged message" "no managed services detected"
assert_log_lacks "slskd project does not compose up" "${DOCKER_LOG}" " up "
assert_log_has "compose projects are queried" "${DOCKER_LOG}" "compose ls"

prepare_case
run_scenario "recorded systemd does not fall through to compose" fail scenario_recorded_systemd_without_units
assert_err_has "missing units are an error" "Refusing to start Docker Compose"
assert_log_lacks "recorded systemd does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "existing subwave-ai project uses compose" ok scenario_compose_project
assert_log_has "compose up for subwave-ai" "${DOCKER_LOG}" " -p subwave-ai "
assert_log_has "compose up builds" "${DOCKER_LOG}" " up "
assert_log_lacks "compose path does not restart systemd" "${SYSTEMCTL_LOG}" "restart "
[[ "$(tr -d '[:space:]' < "$(install_mode_file "${CASE}/repo")")" == "compose" ]] && ok "records compose after up" || bad "records compose after up"

prepare_case
run_scenario "foreign listener blocks restart" fail scenario_port_held
assert_err_has "names the owning pid" "pid 1"
assert_err_has "says nothing was killed" "Nothing was killed"
assert_log_lacks "foreign listener does not restart" "${SYSTEMCTL_LOG}" "restart "
assert_log_lacks "foreign listener does not compose up" "${DOCKER_LOG}" " up "
[[ ! -s "${KILL_LOG}" ]] && ok "foreign listener kills nothing" || bad "foreign listener kills nothing"

prepare_case
run_scenario "listener owned by the api unit can restart" ok scenario_port_owned_by_unit
assert_log_has "owned port still restarts units" "${SYSTEMCTL_LOG}" "restart subwave-api.service subwave-worker.service"
assert_log_lacks "owned port does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "exited compose containers are kept" ok scenario_exited_containers
assert_err_has "warns about the api container" "subwave-ai-api-1"
assert_err_has "tells you how to remove stopped containers" " rm -f"
assert_err_has "names the worker leftover" "subwave-ai-worker-1"
assert_log_has "still restarts systemd" "${SYSTEMCTL_LOG}" "restart subwave-api.service subwave-worker.service"
assert_log_lacks "does not auto-remove containers" "${DOCKER_LOG}" " rm "
assert_log_lacks "does not compose down" "${DOCKER_LOG}" " down "
assert_log_lacks "does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "running compose containers stop the systemd update" fail scenario_running_containers
assert_err_has "running containers name the down command" " down"
assert_err_has "running containers were not removed" "Nothing was stopped or removed"
assert_log_lacks "running containers are not restarted over" "${SYSTEMCTL_LOG}" "restart "
assert_log_lacks "running containers are not removed" "${DOCKER_LOG}" " down "
[[ ! -s "${KILL_LOG}" ]] && ok "running containers kill nothing" || bad "running containers kill nothing"

prepare_case
run_scenario "compose restart is allowed when its api publishes the port" ok scenario_compose_owns_port
assert_log_has "compose up while its proxy holds the port" "${DOCKER_LOG}" " up "
assert_log_lacks "compose owner does not restart systemd" "${SYSTEMCTL_LOG}" "restart "
assert_log_lacks "compose up does not touch slskd" "${DOCKER_LOG}" "smartradio-slskd"

prepare_case
run_scenario "unnamed compose listener is allowed when the api publishes the port" ok scenario_compose_unnamed_port_owner
assert_log_has "unnamed compose listener still composes up" "${DOCKER_LOG}" " up "
assert_log_lacks "unnamed compose listener does not restart systemd" "${SYSTEMCTL_LOG}" "restart "

prepare_case
run_scenario "unnamed listener blocks a systemd restart" fail scenario_unnamed_port_owner_blocks_systemd
assert_err_has "unnamed listener says the process could not be identified" "could not be identified"
assert_err_has "unnamed listener kills nothing" "Nothing was killed"
assert_log_lacks "unnamed listener does not restart" "${SYSTEMCTL_LOG}" "restart "
assert_log_lacks "unnamed listener does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "installed units override a compose mode file" ok scenario_units_override_recorded_compose
assert_err_has "warns that the mode file disagrees" "Staying on systemd"
assert_log_has "disagreement restarts units" "${SYSTEMCTL_LOG}" "restart subwave-api.service subwave-worker.service"
assert_log_lacks "disagreement does not compose up" "${DOCKER_LOG}" " up "
[[ "$(tr -d '[:space:]' < "$(install_mode_file "${CASE}/repo")")" == "systemd" ]] && ok "corrects the mode file to systemd" || bad "corrects the mode file to systemd"

prepare_case
run_scenario "inactive unit after restart is an error" fail scenario_inactive_after_restart
assert_err_has "names the inactive unit" "subwave-api.service is not active"
assert_log_lacks "inactive unit does not compose up" "${DOCKER_LOG}" " up "

prepare_case
run_scenario "api port comes from config, then env, else 8788" ok scenario_yaml_port

prepare_case
run_scenario "root git fetch and pull run as the repo owner" ok scenario_git_as_repo_owner
assert_log_has "chowns .git" "${CASE}/chown.log" "grokbot:grokbot ${CASE}/repo/.git"
assert_log_lacks "git chown skips secrets" "${CASE}/chown.log" "secrets"
assert_log_lacks "git chown skips env" "${CASE}/chown.log" ".env"
assert_log_lacks "git chown skips config" "${CASE}/chown.log" "subwave.yaml"
assert_log_lacks "git chown skips data" "${CASE}/chown.log" "/data"
assert_log_has "git fetch goes through runuser" "${CASE}/runuser.log" "git -C ${CASE}/repo fetch origin"
assert_log_has "git pull goes through runuser" "${CASE}/runuser.log" "git -C ${CASE}/repo pull --rebase --autostash"
assert_log_has "git rev-parse goes through runuser" "${CASE}/runuser.log" "rev-parse --abbrev-ref HEAD"
assert_log_lacks "root run does not fetch directly" "${CASE}/git.log" "fetch"
assert_log_lacks "root run does not pull directly" "${CASE}/git.log" "pull"
assert_log_lacks "root run does not checkout directly" "${CASE}/git.log" "checkout"
assert_log_lacks "root run does not reset directly" "${CASE}/git.log" "reset"
assert_log_lacks "root run does not touch submodules directly" "${CASE}/git.log" "submodule"

prepare_case
run_scenario "non-root git runs directly" ok scenario_git_not_root
assert_log_has "non-root git fetch" "${CASE}/git.log" "fetch origin"
assert_log_has "non-root git pull" "${CASE}/git.log" "pull --rebase --autostash"
[[ ! -s "${CASE}/chown.log" ]] && ok "non-root git does not chown" || bad "non-root git does not chown"
[[ ! -s "${CASE}/runuser.log" ]] && ok "non-root git does not call runuser" || bad "non-root git does not call runuser"

prepare_case
run_scenario "root build runs as the repo owner" ok scenario_build_as_repo_owner
assert_log_has "chowns root node_modules" "${CASE}/chown.log" "grokbot:grokbot ${CASE}/repo/node_modules"
assert_log_has "chowns web dist" "${CASE}/chown.log" "grokbot:grokbot ${CASE}/repo/apps/web/dist"
assert_log_has "chowns package node_modules" "${CASE}/chown.log" "grokbot:grokbot ${CASE}/repo/apps/api/node_modules"
assert_log_has "chowns workspace package node_modules" "${CASE}/chown.log" "grokbot:grokbot ${CASE}/repo/packages/core/node_modules"
assert_log_lacks "does not chown secrets" "${CASE}/chown.log" "secrets"
assert_log_lacks "does not chown env" "${CASE}/chown.log" ".env"
assert_log_lacks "does not chown config" "${CASE}/chown.log" "subwave.yaml"
assert_log_lacks "does not chown data" "${CASE}/chown.log" "data"
assert_log_has "runuser drops to the owner" "${CASE}/runuser.log" "-u grokbot"
assert_log_has "install runs through runuser" "${CASE}/runuser.log" "pnpm install --frozen-lockfile"
assert_log_has "web build runs through runuser" "${CASE}/runuser.log" "pnpm --filter @subwave-ai/web build"
[[ ! -s "${CASE}/pnpm.log" ]] && ok "pnpm is not executed as root" || bad "pnpm is not executed as root"

prepare_case
run_scenario "non-root build stays the current user" ok scenario_build_not_root
assert_log_has "non-root runs pnpm install" "${CASE}/pnpm.log" "install --frozen-lockfile"
assert_log_has "non-root runs the web build" "${CASE}/pnpm.log" "--filter @subwave-ai/web build"
[[ ! -s "${CASE}/runuser.log" ]] && ok "non-root does not call runuser" || bad "non-root does not call runuser"
[[ ! -s "${CASE}/chown.log" ]] && ok "non-root does not chown" || bad "non-root does not chown"

prepare_case
run_scenario "proc net tcp is quiet when ss is absent" ok scenario_proc_fallback_quiet

prepare_case
run_scenario "ss failure falls back to proc" ok scenario_ss_failure_uses_proc

if [[ "${fail}" -ne 0 ]]; then
  printf '%s failed, %s passed\n' "${fail}" "${pass}" >&2
  exit 1
fi
printf '%s passed\n' "${pass}"
