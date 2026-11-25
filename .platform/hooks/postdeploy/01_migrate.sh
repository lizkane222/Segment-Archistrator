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

# Hardcoded, not inherited: manage.py defaults DJANGO_SETTINGS_MODULE to
# config.settings.dev when unset, and this hook's own environment can't be
# relied on to carry the console-configured value -- but this script only
# ever runs against prod, so there's nothing to gain from making it variable.
export DJANGO_SETTINGS_MODULE=config.settings.prod

source /opt/elasticbeanstalk/deployment/custom_env_vars
source /var/app/venv/*/bin/activate
cd /var/app/current

python manage.py migrate --noinput
python manage.py seed_templates
python manage.py sync_catalog || echo "sync_catalog skipped"
