# Панель керування (Solvix.Control) локально: dotnet run, лог у .solvix/logs/panel.log.

PANEL_PORT=5200
PANEL_LOG="$LOG_DIR/panel.log"

panel_start() {
  command -v dotnet >/dev/null 2>&1 || { warn "dotnet не встановлено - панель пропущено"; return 1; }
  if wait_http "http://localhost:$PANEL_PORT/health" 1; then ok "Панель вже працює (http://localhost:$PANEL_PORT)"; return 0; fi
  require_free_port "$PANEL_PORT" "панель"

  : >"$PANEL_LOG"
  (
    cd "$ROOT/Solvix.Control"
    export ASPNETCORE_ENVIRONMENT=Development
    export ASPNETCORE_URLS="http://localhost:$PANEL_PORT"
    nohup dotnet run --no-launch-profile >"$PANEL_LOG" 2>&1 </dev/null &
    echo $! >"$(pid_file panel)"
  )
  local pid; pid="$(read_pid panel)"
  STEP_DIAG="$PANEL_LOG" run_step "Панель керування (http://localhost:$PANEL_PORT)" "$LOG_DIR/panel-wait.log" \
    wait_http "http://localhost:$PANEL_PORT/health" 120 "$pid" \
    || { stop_pid panel; return 1; }
}

panel_stop() { stop_pid panel; }
