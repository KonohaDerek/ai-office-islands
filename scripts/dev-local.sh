#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"

unset AI_OFFICE_ENCRYPTION_KEY AI_OFFICE_ENCRYPTION_KEY_FILE

export AI_OFFICE_SETTINGS_PATH="${AI_OFFICE_SETTINGS_PATH:-$HOME/Documents/Private/09_AI/ai-office-islands/settings.yaml}"
export HERMES_BASE_URL="http://127.0.0.1:8642/v1"

exec node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173 --strictPort "$@"
