#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../../.."

export NG_CLI_ANALYTICS=false

if [ ! -f .env ]; then
  cp .env.example .env
fi

# --- Colima / Docker ---------------------------------------------------

if ! command -v colima >/dev/null 2>&1; then
  echo "colima is not installed (brew install colima)"; exit 1
fi

if ! colima status >/dev/null 2>&1; then
  echo "Colima is not running, starting it..."
  if ! colima start; then
    echo ""
    echo "Colima failed to start. Common fixes:"
    echo "  colima delete && colima start   # rebuild the VM from scratch"
    echo "  colima start --edit             # inspect/adjust cpu/memory/disk"
    exit 1
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker daemon unreachable through Colima even though colima reports running."
  echo "Try: colima restart"
  exit 1
fi

# --- Database ------------------------------------------------------------

docker compose up -d postgres

echo "Waiting for postgres..."
until docker compose ps postgres | grep -q "healthy"; do
  sleep 1
done

# --- App -------------------------------------------------------------------

trap 'kill 0' EXIT

(cd Solvix.Api && dotnet run --launch-profile https) &
(cd solvix-web && npm start) &

echo ""
echo "Frontend: http://localhost:4200"
echo "API:      http://localhost:5168/swagger"
echo ""

wait
