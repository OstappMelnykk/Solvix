#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../.."

if [ ! -f .env ]; then
  cp .env.example .env
fi

echo ""
echo "App: http://localhost:8081"
echo ""

docker compose up --build