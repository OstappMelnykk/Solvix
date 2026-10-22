# Docker/Colima, спільна dev-база та Docker-інстанси (stack).
#
#   dev-база      проєкт solvix-dev,  сервіс devdb      порт $DEV_DB_PORT (спільна для IDE і терміналу)
#   інстанс N     проєкт solvix-N,    postgres+api+web  web 8080+N, db 5440+N, свої томи й мережа

DEV_PROJECT=solvix-dev
STACK_MAX=9

dc_dev() { docker compose -p "$DEV_PROJECT" --project-directory "$ROOT" --profile devdb "$@"; }

# Усе, що змінює порти/томи інстансу, задається середовищем лише на час команди.
dc_stack() {   # dc_stack <N> <аргументи compose...>
  local n="$1"; shift
  ( export STACK_ID="$n" WEB_PORT=$((8080 + n)) DB_PORT=$((5440 + n)) DATA_PREFIX="solvix_stack$n"
    docker compose -p "solvix-$n" --project-directory "$ROOT" "$@" )
}

stack_web_port() { echo $((8080 + $1)); }
stack_db_port()  { echo $((5440 + $1)); }

docker_up() { docker info >/dev/null 2>&1; }

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "docker не встановлено (brew install docker colima)"
  docker_up && return 0
  command -v colima >/dev/null 2>&1 || die "Docker daemon не відповідає, і colima не встановлено. Запусти Docker Desktop."
  run_step "Colima запускається" "$LOG_DIR/colima.log" colima start \
    || die "Colima не стартує. Спробуй: colima delete && colima start"
  docker_up || die "Docker не відповідає навіть після colima start. Спробуй: colima restart"
}

# Стан сервісу проєкту: none | docker-off | running | running/healthy | exited ...
svc_state() {   # svc_state <проєкт> <сервіс>
  docker_up || { echo docker-off; return; }
  local id
  id="$(docker ps -aq --filter "label=com.docker.compose.project=$1" --filter "label=com.docker.compose.service=$2" | head -1)"
  [ -n "$id" ] || { echo none; return; }
  docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$id"
}

svc_running() { case "$(svc_state "$1" "$2")" in running|running/healthy) return 0;; *) return 1;; esac; }

# --- спільна dev-база ------------------------------------------------------

db_start() {
  ensure_docker
  if [ "$(svc_state "$DEV_PROJECT" devdb)" = running/healthy ]; then ok "Dev-база вже працює (:$DEV_DB_PORT)"; return; fi
  local p; p="$(port_pid "$DEV_DB_PORT")"
  [ -z "$p" ] || svc_running "$DEV_PROJECT" devdb || die "Порт $DEV_DB_PORT зайнятий ($(pid_name "$p"), pid $p). Змін DEV_DB_PORT у .env"
  run_step "Dev-база (postgres :$DEV_DB_PORT)" "$LOG_DIR/db.log" dc_dev up -d --wait --wait-timeout 60 devdb \
    || { dc_dev logs --tail 20 devdb 2>/dev/null | sed 's/^/      /'; exit 1; }
}

db_stop() {
  docker_up && svc_running "$DEV_PROJECT" devdb || return 1
  dc_dev stop devdb >"$LOG_DIR/db.log" 2>&1
}

# --- Docker-інстанси -------------------------------------------------------

# Номери всіх існуючих інстансів (навіть зупинених), по одному в рядку.
stack_ids() {
  docker_up || return 0
  docker ps -a --format '{{.Label "com.docker.compose.project"}}' \
    | sed -n 's/^solvix-\([0-9][0-9]*\)$/\1/p' | sort -un
}

stack_next_id() {
  local n=1
  while stack_ids | grep -qx "$n"; do n=$((n + 1)); done
  [ "$n" -le "$STACK_MAX" ] || die "Забагато інстансів (максимум $STACK_MAX)"
  echo "$n"
}

stack_check_id() {
  case "$1" in ''|*[!0-9]*) die "Номер інстансу має бути числом 1-$STACK_MAX";; esac
  { [ "$1" -ge 1 ] && [ "$1" -le "$STACK_MAX" ]; } || die "Номер інстансу має бути 1-$STACK_MAX"
}

# stack_up [N]: без номера - новий інстанс; з номером - (пере)запуск існуючого.
stack_up() {
  ensure_docker
  local n="${1:-}"
  if [ -z "$n" ]; then n="$(stack_next_id)"; else stack_check_id "$n"; fi
  local web db; web="$(stack_web_port "$n")"; db="$(stack_db_port "$n")"
  if svc_running "solvix-$n" web && svc_running "solvix-$n" api; then ok "Інстанс $n вже працює (http://localhost:$web)"; return; fi
  if ! svc_running "solvix-$n" web; then
    local pw pd; pw="$(port_pid "$web")"; pd="$(port_pid "$db")"
    [ -z "$pw" ] || die "Порт $web (web інстансу $n) зайнятий: $(pid_name "$pw") pid $pw"
    [ -z "$pd" ] || svc_running "solvix-$n" postgres || die "Порт $db (db інстансу $n) зайнятий: $(pid_name "$pd") pid $pd"
  fi
  run_step "Інстанс $n: збірка образів (перший раз - кілька хвилин)" "$LOG_DIR/stack-$n-build.log" dc_stack "$n" build || exit 1
  run_step "Інстанс $n: db :$db · api · web :$web" "$LOG_DIR/stack-$n-up.log" \
    dc_stack "$n" up -d --wait --wait-timeout 120 \
    || { dc_stack "$n" logs --tail 20 api web 2>/dev/null | sed 's/^/      /'; exit 1; }
  printf '  %s→ Інстанс %s: http://localhost:%s%s\n' "$BOLD" "$n" "$web" "$RESET"
}

# stack_stop <N>: зупиняє, але лишає контейнери і дані (можна знову запустити).
stack_stop() {
  stack_check_id "$1"
  docker_up && stack_ids | grep -qx "$1" || return 1
  dc_stack "$1" stop >"$LOG_DIR/stack-$1-down.log" 2>&1
}

# stack_rm <N>: видаляє контейнери, мережу і ДАНІ інстансу.
stack_rm() {
  stack_check_id "$1"
  docker_up && stack_ids | grep -qx "$1" || return 1
  dc_stack "$1" down -v >"$LOG_DIR/stack-$1-down.log" 2>&1
}

stack_stop_all() { local n any=1; for n in $(stack_ids); do stack_stop "$n" && any=0; done; return $any; }
