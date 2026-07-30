#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../.."

export NG_CLI_ANALYTICS=false

if [ ! -f .env ]; then
  cp .env.example .env
fi

docker compose up -d postgres

echo "Waiting for postgres..."
until docker compose ps postgres | grep -q "healthy"; do
  sleep 1
done

trap 'kill 0' EXIT

(cd Solvix.Api && dotnet run) &
(cd solvix-web && npm start) &

echo ""
echo "Frontend: http://localhost:4200"
echo "API:      http://localhost:5168/swagger"
echo ""

wait
