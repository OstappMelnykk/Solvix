#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../.."

pkill -f "Solvix.Api" 2>/dev/null || true
pkill -f "ng serve" 2>/dev/null || true

docker compose stop postgres