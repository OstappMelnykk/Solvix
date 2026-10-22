# Backend (Solvix.Api) локально: dotnet run, hot-reload не потрібен, лог у .solvix/logs/be.log.

BE_PORT=7153
BE_LOG="$LOG_DIR/be.log"

be_start() {
  command -v dotnet >/dev/null 2>&1 || die "dotnet не встановлено (потрібен .NET 8 SDK)"
  if [ -n "$(live_pid be)" ]; then ok "Backend вже працює (pid $(live_pid be))"; return; fi
  require_free_port "$BE_PORT" "backend https"
  require_free_port 5168 "backend http"
  [ "$(svc_state postgres)" = running/healthy ] || db_start

  : >"$BE_LOG"
  (
    cd "$ROOT/Solvix.Api"
    export ASPNETCORE_ENVIRONMENT=Development
    export SOLVIX_LAUNCHER=script   # reported to the panel, so it knows who started us
    export Control__Url="http://localhost:$PANEL_PORT"
    export ASPNETCORE_URLS="https://localhost:$BE_PORT;http://localhost:5168"
    export ConnectionStrings__Default="Host=localhost;Port=$DB_PORT;Database=$POSTGRES_DB;Username=$POSTGRES_USER;Password=$POSTGRES_PASSWORD"
    nohup dotnet run --no-launch-profile >"$BE_LOG" 2>&1 </dev/null &
    echo $! >"$(pid_file be)"
  )
  local pid; pid="$(read_pid be)"
  STEP_DIAG="$BE_LOG" run_step "Backend (https://localhost:$BE_PORT)" "$LOG_DIR/be-wait.log" \
    wait_http "https://localhost:$BE_PORT/api/health" 240 "$pid" \
    || { stop_pid be; exit 1; }
}

be_stop() { stop_pid be; }
