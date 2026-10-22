# Docker/Colima та сервіси compose: db (postgres), app (api + web).

dc() { docker compose --project-directory "$ROOT" "$@"; }

docker_up() { docker info >/dev/null 2>&1; }

ensure_docker() {
  command -v docker >/dev/null 2>&1 || die "docker не встановлено (brew install docker colima)"
  docker_up && return 0
  command -v colima >/dev/null 2>&1 || die "Docker daemon не відповідає, і colima не встановлено. Запусти Docker Desktop."
  run_step "Colima запускається" "$LOG_DIR/colima.log" colima start \
    || die "Colima не стартує. Спробуй: colima delete && colima start"
  docker_up || die "Docker не відповідає навіть після colima start. Спробуй: colima restart"
}

# Стан сервісу: none | docker-off | running | running/healthy | exited ...
svc_state() {
  docker_up || { echo docker-off; return; }
  local id; id="$(dc ps -aq "$1" 2>/dev/null | head -1)"
  [ -n "$id" ] || { echo none; return; }
  docker inspect -f '{{.State.Status}}{{if .State.Health}}/{{.State.Health.Status}}{{end}}' "$id"
}

svc_running() { case "$(svc_state "$1")" in running|running/healthy) return 0;; *) return 1;; esac; }

# --- db ----------------------------------------------------------------------

db_start() {
  ensure_docker
  if [ "$(svc_state postgres)" = running/healthy ]; then ok "База вже працює (:$DB_PORT)"; return; fi
  local p; p="$(port_pid "$DB_PORT")"
  [ -z "$p" ] || svc_running postgres || die "Порт $DB_PORT зайнятий ($(pid_name "$p"), pid $p). Змін DB_PORT у .env"
  run_step "База даних (postgres :$DB_PORT)" "$LOG_DIR/db.log" dc up -d --wait --wait-timeout 60 postgres \
    || { dc logs --tail 20 postgres 2>/dev/null | sed 's/^/      /'; exit 1; }
}

db_stop() {
  docker_up && svc_running postgres || return 1
  dc stop postgres >"$LOG_DIR/db.log" 2>&1
}

# --- app (api + web у контейнерах) -----------------------------------------

app_start() {
  ensure_docker
  if svc_running web && svc_running api; then ok "Застосунок вже працює"; return; fi
  require_free_port "$WEB_PORT" "web"
  run_step "Збірка образів (перший раз - кілька хвилин)" "$LOG_DIR/docker-build.log" dc build \
    || exit 1
  run_step "Запуск api + web" "$LOG_DIR/docker-up.log" dc up -d --wait --wait-timeout 120 \
    || { dc logs --tail 20 api web 2>/dev/null | sed 's/^/      /'; exit 1; }
}

app_stop() {
  docker_up && { svc_running api || svc_running web; } || return 1
  dc rm -sf api web >"$LOG_DIR/docker-down.log" 2>&1
}
