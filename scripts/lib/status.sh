# status / doctor / logs - що зараз запущено і чи все гаразд.

STATUS_RUNNING=0

_row() {   # _row <on|off|warn> <назва> <порт> <опис>
  local dot
  case "$1" in
    on)   dot="${GREEN}●${RESET}"; STATUS_RUNNING=$((STATUS_RUNNING + 1));;
    warn) dot="${YELLOW}●${RESET}";;
    *)    dot="${DIM}○${RESET}";;
  esac
  printf '  %s %-5s %-6s %s\n' "$dot" "$2" "$3" "$4"
}

_proc_row() {   # _proc_row <компонент> <порт> <url> - локальний процес (be/fe)
  local c="$1" port="$2" url="$3" p lp
  lp="$(live_pid "$c")"; p="$(port_pid "$port")"
  if [ -n "$lp" ] && [ -n "$p" ]; then
    _row on "$c" ":$port" "працює · $url · pid $lp · $(pid_age "$lp")"
  elif [ -n "$lp" ]; then
    _row warn "$c" ":$port" "стартує або завис · pid $lp · лог: solvix logs $c"
  elif [ -n "$p" ]; then
    _row warn "$c" ":$port" "порт зайнятий ЧУЖИМ процесом: $(pid_name "$p") (pid $p)"
  else
    _row off "$c" "" "вимкнено"
  fi
}

_panel_row() {
  if wait_http "http://localhost:$PANEL_PORT/health" 1; then
    local lp; lp="$(live_pid panel)"
    _row on panel ":$PANEL_PORT" "працює · http://localhost:$PANEL_PORT${lp:+ · pid $lp · $(pid_age "$lp")}"
  else
    _row off panel "" "вимкнено"
  fi
}

_db_row() {
  local s; s="$(svc_state "$DEV_PROJECT" devdb)"
  case "$s" in
    running/healthy|running) _row on db ":$DEV_DB_PORT" "працює · спільна dev-база (IDE + термінал) · docker${s#running}";;
    docker-off|none|exited*|created*|dead*) _row off db "" "вимкнено (спільна dev-база)";;
    *) _row warn db ":$DEV_DB_PORT" "docker: $s";;
  esac
}

_stack_rows() {
  local n web db api up total
  for n in $(stack_ids); do
    web="$(stack_web_port "$n")"; db="$(stack_db_port "$n")"; api="$(stack_api_port "$n")"
    up=0; total=0
    for s in postgres api web; do
      total=$((total + 1)); svc_running "solvix-$n" "$s" && up=$((up + 1))
    done
    if [ "$up" -eq "$total" ]; then _row on "st$n" ":$web" "працює · http://localhost:$web · db :$db · api :$api · web :$web"
    elif [ "$up" -gt 0 ]; then _row warn "st$n" ":$web" "частково: $up з $total контейнерів"
    else _row off "st$n" "" "зупинено (дані збережені) · solvix stack up $n"; fi
  done
}

cmd_status() {
  STATUS_RUNNING=0
  printf '\n  %sSolvix%s\n' "$BOLD" "$RESET"
  _panel_row
  _db_row
  _proc_row be 7153 "https://localhost:7153/swagger"
  _proc_row fe 4200 "http://localhost:4200"
  _stack_rows

  if docker_up; then
    local others
    others="$(docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2 !~ /^solvix(-dev|-[0-9]+)?$/ {printf "%s ", $1}')"
    [ -z "$others" ] || printf '\n  %sІнші контейнери (не Solvix, не чіпаємо): %s%s\n' "$DIM" "$others" "$RESET"
  fi

  echo
  if [ "$STATUS_RUNNING" -gt 0 ]; then
    printf '  %sПрацює: %s. Вимкнути все: ./scripts/solvix down%s\n\n' "$YELLOW" "$STATUS_RUNNING" "$RESET"
  else
    printf '  %sНічого не запущено.%s\n\n' "$DIM" "$RESET"
  fi
}

cmd_logs() {   # logs [be|fe|db|api|web] [-f]
  local target="${1:-}" follow=""
  [ "${2:-}" = "-f" ] || [ "$target" = "-f" ] && follow=1
  [ "$target" = "-f" ] && target=""
  case "$target" in
    ""|journal)
      if [ -n "$follow" ]; then tail -n 30 -f "$JOURNAL"; else tail -n 40 "$JOURNAL" 2>/dev/null || echo "  журнал порожній"; fi;;
    be|fe|panel)
      local f="$LOG_DIR/$target.log"
      [ -f "$f" ] || die "Логу $target ще немає"
      if [ -n "$follow" ]; then tail -n 50 -f "$f"; else tail -n 80 "$f"; fi;;
    db)
      ensure_docker
      if [ -n "$follow" ]; then dc_dev logs -f --tail 50 devdb; else dc_dev logs --tail 80 devdb; fi;;
    stack)   # logs stack <N> <api|web|postgres> [-f]
      ensure_docker
      local n="${2:-}" svc="${3:-api}"
      [ -n "$n" ] || die "Вкажи номер інстансу: solvix logs stack 1 api"
      follow=""; [ "${4:-}" = "-f" ] || [ "$svc" = "-f" ] && follow=1
      [ "$svc" = "-f" ] && svc=api
      if [ -n "$follow" ]; then dc_stack "$n" logs -f --tail 50 "$svc"; else dc_stack "$n" logs --tail 80 "$svc"; fi;;
    *) die "Невідомий лог '$target'. Варіанти: be fe panel db, stack <N> <api|web|postgres> (без аргументу - журнал дій)";;
  esac
}

cmd_doctor() {
  local bad=0
  _chk() { if [ "$1" = ok ]; then ok "$2"; elif [ "$1" = warn ]; then warn "$2"; else fail "$2"; bad=1; fi; }
  printf '\n  %sПеревірка середовища%s\n' "$BOLD" "$RESET"

  if docker_up; then _chk ok "Docker відповідає"
  elif command -v colima >/dev/null 2>&1; then _chk warn "Docker вимкнений - colima стартує автоматично при запуску"
  else _chk fail "Docker не відповідає і colima не встановлено"; fi

  if command -v dotnet >/dev/null 2>&1; then
    case "$(dotnet --version)" in 8.*|9.*|10.*) _chk ok "dotnet $(dotnet --version)";; *) _chk fail "dotnet $(dotnet --version), потрібен 8+";; esac
    dotnet dev-certs https --check >/dev/null 2>&1 \
      && _chk ok "dev-сертифікат https є" \
      || _chk fail "немає dev-сертифіката: dotnet dev-certs https --trust"
  else _chk warn "dotnet не встановлено (потрібен лише для режиму up; demo працює без нього)"; fi

  if command -v node >/dev/null 2>&1; then
    local major; major="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
    [ "$major" -ge 20 ] && _chk ok "node $(node -v)" || _chk fail "node $(node -v), потрібен 20+"
    [ -d "$ROOT/solvix-web/node_modules" ] && _chk ok "node_modules є" || _chk warn "node_modules немає - npm ci виконається при першому up"
  else _chk warn "node не встановлено (потрібен лише для режиму up)"; fi

  [ -f "$ROOT/.env" ] && _chk ok ".env є" || _chk warn ".env буде створено з .env.example"

  local pair port what p
  for pair in "$PANEL_PORT:panel" "$DEV_DB_PORT:dev-db" "7153:be" "5168:be-http" "4200:fe"; do
    port="${pair%%:*}"; what="${pair##*:}"; p="$(port_pid "$port")"
    if [ -z "$p" ]; then _chk ok "порт $port ($what) вільний"
    else _chk warn "порт $port ($what) зайнятий: $(pid_name "$p") pid $p"; fi
  done
  echo
  return $bad
}
