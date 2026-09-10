#!/usr/bin/env bash
#
# Stop whatever is running, rebuild the backend and frontend, apply the latest
# migrations, and start the app fresh on http://localhost:8000.
#
# One service, not two: Django serves the built SPA (see config/urls.py), so
# there is nothing to run on the frontend side day to day -- this script builds
# it once into ../static/spa and lets `runserver` serve it from there.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT=8010
HERE="$(pwd)"

echo "==> Stopping anything already on :$PORT"
PIDS="$(lsof -ti ":$PORT" 2>/dev/null || true)"
OTHERS=""
for pid in $PIDS; do
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n '3s/^n//p')"
  if [ "$cwd" = "$HERE" ]; then
    kill "$pid" 2>/dev/null || true
  else
    OTHERS="$OTHERS $pid(${cwd:-unknown})"
  fi
done
if [ -n "$OTHERS" ]; then
  echo "!! :$PORT is held by a process this script did not start: $OTHERS"
  echo "   Leaving it alone. Stop it yourself, or change PORT in this script."
  exit 1
fi

echo "==> Making sure Postgres is up (segarch-pg)"
docker start segarch-pg >/dev/null 2>&1 \
  || docker run -d --name segarch-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=segarch -p 5432:5432 postgres:16 >/dev/null

echo "==> Backend: installing deps + migrating"
source .venv/bin/activate
pip install -q -r requirements.txt
python manage.py migrate

echo "==> Frontend: installing deps + building"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null
fi
(cd frontend && npm install && npm run build)

echo "==> Collecting static files"
python manage.py collectstatic --noinput >/dev/null

echo "==> Starting the server on http://localhost:$PORT"
exec python manage.py runserver "0.0.0.0:$PORT"
