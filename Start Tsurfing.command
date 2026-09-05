#!/bin/zsh
set -e

cd "$(dirname "$0")"

if [[ ! -d node_modules ]]; then
  npm install
fi

if curl --fail --silent http://localhost:3000/api/v1/health >/dev/null 2>&1; then
  open http://localhost:3000
  exit 0
fi

(sleep 2; open http://localhost:3000) &
exec npm run local
