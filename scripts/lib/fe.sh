# Frontend (solvix-web) локально: ng serve, лог у .solvix/logs/fe.log.

FE_PORT=4200
FE_LOG="$LOG_DIR/fe.log"

fe_start() {
  command -v npm >/dev/null 2>&1 || die "npm не встановлено (потрібен Node 20+)"
  if [ -n "$(live_pid fe)" ]; then ok "Frontend вже працює (pid $(live_pid fe))"; return; fi
  require_free_port "$FE_PORT" "frontend"

  if [ ! -d "$ROOT/solvix-web/node_modules" ]; then
    run_step "npm ci (перший раз)" "$LOG_DIR/npm-ci.log" bash -c "cd '$ROOT/solvix-web' && npm ci" || exit 1
  fi

  : >"$FE_LOG"
  (
    cd "$ROOT/solvix-web"
    export NG_CLI_ANALYTICS=false
    nohup npm start >"$FE_LOG" 2>&1 </dev/null &
    echo $! >"$(pid_file fe)"
  )
  local pid; pid="$(read_pid fe)"
  STEP_DIAG="$FE_LOG" run_step "Frontend (http://localhost:$FE_PORT)" "$LOG_DIR/fe-wait.log" \
    wait_http "http://localhost:$FE_PORT" 240 "$pid" \
    || { stop_pid fe; exit 1; }
}

fe_stop() { stop_pid fe; }
