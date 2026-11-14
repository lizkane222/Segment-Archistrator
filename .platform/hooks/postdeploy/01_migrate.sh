#!/bin/bash
# Mirrors the migrate / seed_templates / sync_catalog steps in render.yaml's
# buildCommand. They can't run in CodeBuild (no access to the real
# DATABASE_URL there), and they can't run in .ebextensions container_commands
# (those run BEFORE predeploy/01_fetch_secrets.sh, so DATABASE_URL and
# SECRET_KEY wouldn't exist yet). postdeploy runs after secrets are fetched
# and after the app is live, so both are available here.
#
# Assumes a single-instance environment (no leader election needed). If this
# ever moves to a load-balanced, multi-instance environment, this needs a
# leader check first or migrations will race across instances.
set -euo pipefail

source /opt/elasticbeanstalk/deployment/env
source /var/app/venv/*/bin/activate
cd /var/app/current

python manage.py migrate --noinput
python manage.py seed_templates
python manage.py sync_catalog || echo "sync_catalog skipped"
