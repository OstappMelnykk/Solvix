# Спільні утиліти: вивід, журнал, .env, порти, pid-файли, очікування.
# Підключається з scripts/solvix. Сумісно з bash 3.2 (macOS).

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="$ROOT/.solvix"
RUN_DIR="$STATE_DIR/run"
LOG_DIR="$STATE_DIR/logs"
JOURNAL="$LOG_DIR/solvix.log"
mkdir -p "$RUN_DIR" "$LOG_DIR"

if [ -t 1 ]; then
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
else
  RED=""; GREEN=""; YELLOW=""; DIM=""; BOLD=""; RESET=""
fi

# --- журнал: кожна дія ідеться у .solvix/logs/solvix.log ---------------------

journal() {   # journal <рівень> <текст>
  if [ -f "$JOURNAL" ] && [ "$(wc -c <"$JOURNAL")" -gt 1048576 ]; then
    mv "$JOURNAL" "$JOURNAL.1"
  fi
  printf '%s [%s] %s\n' "$(date '+%F %T')" "$1" "$2" >>"$JOURNAL"
}

ok()   { printf '  %s✔%s %s\n' "$GREEN" "$RESET" "$*"; journal ok "$*"; }
info() { printf '  %s•%s %s\n' "$DIM" "$RESET" "$*"; journal info "$*"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; journal warn "$*"; }
fail() { printf '  %s✖%s %s\n' "$RED" "$RESET" "$*"; journal fail "$*"; }
die()  { fail "$*"; exit 1; }

# --- .env --------------------------------------------------------------------

load_env() {
  [ -f "$ROOT/.env" ] || { cp "$ROOT/.env.example" "$ROOT/.env"; info "Створено .env з .env.example"; }
  set -a; . "$ROOT/.env"; set +a
  : "${POSTGRES_DB:=solvix}" "${POSTGRES_USER:=solvix}" "${POSTGRES_PASSWORD:=changeme}"
  : "${DB_PORT:=5434}" "${WEB_PORT:=8081}"
  export POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD DB_PORT WEB_PORT
}

# --- порти та процеси --------------------------------------------------------

port_pid()  { lsof -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1; }
pid_alive() { [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null; }
pid_name()  { ps -o comm= -p "$1" 2>/dev/null | sed 's|.*/||'; }
pid_age()   { ps -o etime= -p "$1" 2>/dev/null | tr -d ' '; }

pid_file()  { echo "$RUN_DIR/$1.pid"; }
read_pid()  { local f; f="$(pid_file "$1")"; [ -f "$f" ] && cat "$f" || true; }

# Живий pid компонента або порожньо (протухлий pid-файл прибирається).
live_pid() {
  local p; p="$(read_pid "$1")"
  if pid_alive "$p"; then echo "$p"; else rm -f "$(pid_file "$1")"; fi
}

kill_tree() {   # kill_tree <pid> - цей процес і всі нащадки (dotnet run -> dotnet, npm -> node)
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

stop_pid() {   # stop_pid <компонент> -> 0 якщо зупинили
  local p; p="$(live_pid "$1")"
  [ -n "$p" ] || return 1
  kill_tree "$p"
  local i=0
  while pid_alive "$p" && [ $i -lt 40 ]; do sleep 0.25; i=$((i + 1)); done
  pid_alive "$p" && kill -9 "$p" 2>/dev/null || true
  rm -f "$(pid_file "$1")"
  return 0
}

# Порт має бути вільним (або зайнятим нашим процесом).
require_free_port() {   # require_free_port <порт> <що це>
  local p; p="$(port_pid "$1")"
  [ -z "$p" ] && return 0
  die "Порт $1 ($2) зайнятий процесом $(pid_name "$p") (pid $p). Звільни: kill $p"
}

# --- кроки з анімацією -------------------------------------------------------

# run_step <підпис> <лог> <команда...>: тихо, зі спінером; при помилці показує хвіст логу.
run_step() {
  local label="$1" log="$2"; shift 2
  "$@" >"$log" 2>&1 &
  local pid=$! i=0 frames='|/-\'
  if [ -t 1 ]; then
    while kill -0 "$pid" 2>/dev/null; do
      printf '\r  %s %s' "${frames:$((i % 4)):1}" "$label"
      i=$((i + 1)); sleep 0.15
    done
    printf '\r\033[K'
  fi
  if wait "$pid"; then
    ok "$label"
  else
    fail "$label"
    grep -v "^[[:space:]]*$" "${STEP_DIAG:-$log}" | tail -n 20 | sed 's/^/      /'
    printf '      %sповний лог: %s%s\n' "$DIM" "${STEP_DIAG:-$log}" "$RESET"
    return 1
  fi
}

# wait_http <url> <таймаут_с> [pid, який має лишатись живим]
wait_http() {
  local url="$1" timeout="$2" pid="${3:-}" t=0
  while [ "$t" -lt "$timeout" ]; do
    curl -fsk -o /dev/null --max-time 2 "$url" && return 0
    if [ -n "$pid" ] && ! pid_alive "$pid"; then return 1; fi
    sleep 1; t=$((t + 1))
  done
  return 1
}

confirm() {   # confirm <питання>
  local a; printf '  %s [y/N] ' "$1"; read -r a
  [ "$a" = y ] || [ "$a" = Y ] || [ "$a" = yes ]
}
