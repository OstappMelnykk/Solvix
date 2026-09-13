#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/../../.."

# Only stops the postgres container - Colima itself, and any other
# container running on it (e.g. an unrelated sqlserver container), are left
# alone. Stop Solvix.Api/solvix-web from your IDE, the same place you
# started them.
docker compose stop postgres
