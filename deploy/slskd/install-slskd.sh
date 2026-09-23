#!/usr/bin/env bash
# Optional slskd installer. Not part of SmartRadio's ./install.sh or app image.
# Generates an API key when missing, creates host directories, then
# `docker compose up` unless --prepare-only is set.
# Does not write the library, does not chmod music world-writable, and
# does not delete music on --down.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ROOT}/.env"
EXAMPLE="${ROOT}/.env.example"

usage() {
  cat <<'EOF'
Usage: ./deploy/slskd/install-slskd.sh [--prepare-only | --down]

  (no flag)       Create .env, API key, and directories, then compose up
  --prepare-only  Write .env and directories only. Does not need Docker
  --down          Stop the compose project. Does not delete host directories

Soulseek username and password belong in deploy/slskd/.env only.
SmartRadio stores the API key later, from the setup UI, in secrets/slskd_api_key.
This script does not enqueue searches or downloads.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() { echo "warning: $*" >&2; }
info() { echo "==> $*"; }

ACTION="up"
NEED_CREDENTIALS=0
case "${1:-}" in
  "" ) ACTION="up" ;;
  --prepare-only) ACTION="prepare" ;;
  --down) ACTION="down" ;;
  -h|--help) usage; exit 0 ;;
  *) die "unknown argument: $1" ;;
esac

if [[ "$#" -gt 1 ]]; then
  die "unexpected extra argument: $2"
fi

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  s="${s%$'\r'}"
  printf '%s' "$s"
}

env_get() {
  local key="$1" file="$2" line val=""
  [[ -f "$file" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^[[:space:]]*${key}=(.*)$ ]]; then
      val="$(trim "${BASH_REMATCH[1]}")"
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then val="${BASH_REMATCH[1]}"; fi
      if [[ "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    fi
  done < "$file"
  printf '%s' "$val"
}

env_set() {
  local key="$1" value="$2" file="$3" tmp found=0 line
  tmp="$(mktemp)"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*${key}= ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
      found=1
    else
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$file"
  if [[ "$found" -eq 0 ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$file"
  rm -f "$tmp"
  chmod 600 "$file"
}

abs_path() {
  local p="$1"
  if [[ "$p" == /* ]]; then
    realpath -m "$p"
  else
    realpath -m "${ROOT}/${p}"
  fi
}

same_or_nested() {
  local a b
  a="$(realpath -m "$1")"
  b="$(realpath -m "$2")"
  [[ "$a" == "$b" || "$a" == "$b"/* || "$b" == "$a"/* ]]
}

other_can_write() {
  local perms
  perms="$(stat -c '%A' "$1")"
  # drwxrwxrwx — other-write is the 9th character (index 8).
  [[ "${perms:8:1}" == "w" ]]
}

generate_api_key() {
  local key=""
  if command -v openssl >/dev/null 2>&1; then
    key="$(openssl rand -hex 32)"
  else
    key="$(od -An -tx1 -N 32 /dev/urandom | tr -d ' \n')"
  fi
  key="$(trim "$key")"
  if [[ "${#key}" -lt 16 || "${#key}" -gt 255 ]]; then
    die "generated API key length ${#key} is outside slskd's 16-255 character range"
  fi
  printf '%s' "$key"
}

reject_umask() {
  local value="$1"
  case "$value" in
    0000|000|0) die "SLSKD_UMASK=${value} would make new files world-writable. Use 0022 or 0027." ;;
  esac
  [[ "$value" =~ ^[0-7]{3,4}$ ]] || die "SLSKD_UMASK must be an octal mask such as 0022"
}

reject_library() {
  local label="$1" path="$2" lib resolved
  resolved="$(realpath -m "$path")"
  case "$resolved" in
    /music/library|/music/library/*)
      die "${label} (${path}) is the library path. This package does not mount or write it."
      ;;
  esac
  if [[ -n "${SLSKD_LIBRARY_DIR:-}" ]]; then
    die "SLSKD_LIBRARY_DIR is set. This package does not mount or write the library. Unset it."
  fi
  for lib in "${SUBWAVE_LIBRARY_DIR:-}" "${LIBRARY_DIR:-}"; do
    [[ -z "$lib" ]] && continue
    if same_or_nested "$resolved" "$lib"; then
      die "${label} (${path}) overlaps the SmartRadio library (${lib}). slskd must not write that tree."
    fi
  done
}

ensure_dir() {
  local path="$1" label="$2" uid="$3" gid="$4" created=0 owner
  if [[ -e "$path" && ! -d "$path" ]]; then
    die "${label} exists and is not a directory: ${path}"
  fi
  if [[ ! -d "$path" ]]; then
    mkdir -p "$path"
    chmod 0750 "$path"
    created=1
    if [[ "$(id -u)" -eq 0 ]]; then
      chown "${uid}:${gid}" "$path"
    fi
    info "created ${label}: ${path} (mode 0750)"
  else
    info "keeping existing ${label}: ${path}"
  fi
  if other_can_write "$path"; then
    if [[ "$created" -eq 1 ]]; then
      die "refusing to leave a new world-writable directory: ${path}"
    fi
    warn "${label} is already world-writable (${path}). Not changing it, and not adding write for others."
  fi
  if [[ "$created" -eq 0 && "$(id -u)" -ne 0 ]]; then
    owner="$(stat -c '%u' "$path")"
    if [[ "$owner" != "$uid" ]]; then
      warn "${label} is owned by uid ${owner}, but SLSKD_UID is ${uid}. Not changing ownership."
    fi
  fi
}

compose() {
  local env_args=()
  if [[ -f "$ENV_FILE" ]]; then
    env_args=(--env-file "$ENV_FILE")
  fi
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "${ROOT}/docker-compose.yml" "${env_args[@]}" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "${ROOT}/docker-compose.yml" "${env_args[@]}" "$@"
  else
    die "docker compose is required to start or stop slskd. --prepare-only does not need Docker."
  fi
}

prepare() {
  [[ -f "$EXAMPLE" ]] || die "missing ${EXAMPLE}"
  if [[ ! -f "$ENV_FILE" ]]; then
    umask 077
    cp "$EXAMPLE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    info "wrote ${ENV_FILE} from .env.example"
  else
    chmod 600 "$ENV_FILE"
  fi

  local uid gid umask_value api_key username password
  uid="$(env_get SLSKD_UID "$ENV_FILE")"
  gid="$(env_get SLSKD_GID "$ENV_FILE")"
  if [[ -z "$uid" ]]; then
    uid="$(id -u)"
    env_set SLSKD_UID "$uid" "$ENV_FILE"
  fi
  if [[ -z "$gid" ]]; then
    gid="$(id -g)"
    env_set SLSKD_GID "$gid" "$ENV_FILE"
  fi
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || die "SLSKD_UID and SLSKD_GID must be numeric"
  if [[ "$uid" == "0" ]]; then
    warn "SLSKD_UID is 0, so the container runs as root. Set SLSKD_UID and SLSKD_GID to the account that should own downloads."
  fi

  umask_value="$(env_get SLSKD_UMASK "$ENV_FILE")"
  umask_value="${umask_value:-0022}"
  reject_umask "$umask_value"

  api_key="$(env_get SLSKD_API_KEY "$ENV_FILE")"
  if [[ -z "$api_key" ]]; then
    api_key="$(generate_api_key)"
    env_set SLSKD_API_KEY "$api_key" "$ENV_FILE"
    info "generated SLSKD_API_KEY in ${ENV_FILE} (not printed). Paste it into the SmartRadio setup UI."
  elif [[ "${#api_key}" -lt 16 || "${#api_key}" -gt 255 ]]; then
    die "SLSKD_API_KEY must be 16-255 characters. Refusing to replace an existing value."
  else
    info "keeping existing SLSKD_API_KEY"
  fi

  local app_rel downloads_rel incomplete_rel app_dir downloads_dir incomplete_dir
  app_rel="$(env_get SLSKD_APP_DIR "$ENV_FILE")"
  downloads_rel="$(env_get SLSKD_DOWNLOADS_DIR "$ENV_FILE")"
  incomplete_rel="$(env_get SLSKD_INCOMPLETE_DIR "$ENV_FILE")"
  [[ -n "$app_rel" && -n "$downloads_rel" && -n "$incomplete_rel" ]] || die "SLSKD_APP_DIR, SLSKD_DOWNLOADS_DIR, and SLSKD_INCOMPLETE_DIR must be set"
  app_dir="$(abs_path "$app_rel")"
  downloads_dir="$(abs_path "$downloads_rel")"
  incomplete_dir="$(abs_path "$incomplete_rel")"

  if [[ "$app_dir" == "$downloads_dir" || "$app_dir" == "$incomplete_dir" || "$downloads_dir" == "$incomplete_dir" ]]; then
    die "app state, completed downloads, and incomplete downloads must be three different directories"
  fi
  reject_library "app state" "$app_dir"
  reject_library "completed downloads" "$downloads_dir"
  reject_library "incomplete downloads" "$incomplete_dir"

  umask 027
  ensure_dir "$app_dir" "slskd config/state" "$uid" "$gid"
  ensure_dir "$downloads_dir" "completed downloads" "$uid" "$gid"
  ensure_dir "$incomplete_dir" "incomplete downloads" "$uid" "$gid"

  username="$(env_get SLSKD_SLSK_USERNAME "$ENV_FILE")"
  password="$(env_get SLSKD_SLSK_PASSWORD "$ENV_FILE")"
  if [[ -z "$username" || -z "$password" ]]; then
    NEED_CREDENTIALS=1
    cat <<EOF

Soulseek username and password are still empty in ${ENV_FILE}.
Those are slskd secrets. This script does not invent them and does not store them in SmartRadio.
Fill SLSKD_SLSK_USERNAME and SLSKD_SLSK_PASSWORD, then re-run:
  ${ROOT}/install-slskd.sh
EOF
  fi
}

print_next() {
  local http_port http_bind
  http_port="$(env_get SLSKD_HTTP_PORT "$ENV_FILE")"
  http_bind="$(env_get SLSKD_HTTP_BIND "$ENV_FILE")"
  http_port="${http_port:-5030}"
  http_bind="${http_bind:-127.0.0.1}"
  cat <<EOF

Phase B/C handoff (no search or download from this script):
  1. Confirm ports. API ${http_port} (bind ${http_bind}), optional HTTPS 5031, Soulseek listen 50300.
  2. In SmartRadio's .env set SLSKD_URL=http://127.0.0.1:${http_port} when slskd is on this host.
     Use a host address the API can reach if SmartRadio itself runs in Docker.
  3. Open the setup wizard or Settings. Enable acquisition, provider slskd.
     Paste SLSKD_API_KEY from ${ENV_FILE}. The UI writes secrets/slskd_api_key and does not show it again.
     Set Downloads to the same host path as SLSKD_DOWNLOADS_DIR. Leave the library path as SmartRadio's library.
  4. Save, then Test connection. verified is stored only when that probe is Ready.
  5. Restart the SmartRadio worker after a successful test.

Stop slskd without deleting music:
  ${ROOT}/install-slskd.sh --down
EOF
}

if [[ "$ACTION" == "down" ]]; then
  # Compose refuses to parse while a required value is empty. Fill only the
  # empty ones in this process so `down` still works, and do not write them
  # back to .env. `down` does not delete bind-mounted host directories.
  fill_if_empty() {
    local key="$1" fallback="$2" val=""
    if [[ -f "$ENV_FILE" ]]; then
      val="$(env_get "$key" "$ENV_FILE")"
    fi
    if [[ -z "$val" ]]; then
      export "$key=$fallback"
    fi
  }
  fill_if_empty SLSKD_UID 65534
  fill_if_empty SLSKD_GID 65534
  fill_if_empty SLSKD_APP_DIR /tmp
  fill_if_empty SLSKD_DOWNLOADS_DIR /tmp
  fill_if_empty SLSKD_INCOMPLETE_DIR /tmp
  fill_if_empty SLSKD_SLSK_USERNAME down
  fill_if_empty SLSKD_SLSK_PASSWORD down
  fill_if_empty SLSKD_API_KEY 0000000000000000
  info "stopping smartradio-slskd (host directories are left in place)"
  compose down
  if [[ -f "$ENV_FILE" ]]; then
    echo "Left in place:"
    echo "  config/state: $(abs_path "$(env_get SLSKD_APP_DIR "$ENV_FILE")")"
    echo "  downloads:    $(abs_path "$(env_get SLSKD_DOWNLOADS_DIR "$ENV_FILE")")"
    echo "  incomplete:   $(abs_path "$(env_get SLSKD_INCOMPLETE_DIR "$ENV_FILE")")"
  fi
  echo "The library directory was not mounted and was not deleted."
  exit 0
fi

prepare
if [[ "$ACTION" == "prepare" ]]; then
  info "prepare only; container was not started"
  if [[ "$NEED_CREDENTIALS" -eq 0 ]]; then
    print_next
  fi
  exit 0
fi
if [[ "$NEED_CREDENTIALS" -eq 1 ]]; then
  exit 1
fi

info "starting slskd (project smartradio-slskd)"
compose up -d
print_next
