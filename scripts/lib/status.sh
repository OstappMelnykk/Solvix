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

_svc_row() {   # _svc_row <сервіс compose> <назва> <порт> <url>
  local s; s="$(svc_state "$1")"
  case "$s" in
    running/healthy|running) _row on "$2" "$3" "працює · $4 · docker${s#running}";;
    docker-off|none|exited*|created*|dead*) _row off "$2" "" "вимкнено";;
    *)                       _row warn "$2" "$3" "docker: $s";;
  esac
}

cmd_status() {
  STATUS_RUNNING=0
  printf '\n  %sSolvix%s\n' "$BOLD" "$RESET"
  _panel_row
  _svc_row postgres db  ":$DB_PORT" "postgres"
  _proc_row be 7153 "https://localhost:7153/swagger"
  _proc_row fe 4200 "http://localhost:4200"
  _svc_row api api "" "контейнер"
  _svc_row web web ":$WEB_PORT" "http://localhost:$WEB_PORT"

  if docker_up; then
    local others
    others="$(docker ps --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2 != "solvix" {printf "%s ", $1}')"
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
    db|api|web)
      ensure_docker
      local s="$target"; [ "$s" = db ] && s=postgres
      if [ -n "$follow" ]; then dc logs -f --tail 50 "$s"; else dc logs --tail 80 "$s"; fi;;
    *) die "Невідомий лог '$target'. Варіанти: be fe panel db api web (без аргументу - журнал дій)";;
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
  for pair in "$PANEL_PORT:panel" "$DB_PORT:db" "$WEB_PORT:web" "7153:be" "5168:be-http" "4200:fe"; do
    port="${pair%%:*}"; what="${pair##*:}"; p="$(port_pid "$port")"
    if [ -z "$p" ]; then _chk ok "порт $port ($what) вільний"
    else _chk warn "порт $port ($what) зайнятий: $(pid_name "$p") pid $p"; fi
  done
  echo
  return $bad
}
