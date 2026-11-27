#!/bin/bash
# Pulls secrets out of SSM Parameter Store into a file this app's own hooks
# control, so they never sit in plaintext EB environment properties (visible
# to anyone with EB console/CLI read access).
#
# NOT /opt/elasticbeanstalk/deployment/env: that file is EB's own and isn't a
# reliable handoff to a later hook -- in practice it reads back empty by the
# time postdeploy/01_migrate.sh sources it, even though this hook successfully
# wrote to it moments earlier. A file only our own hooks touch has no such
# surprise.
#
# Requires the EB EC2 instance role to have ssm:GetParameter on
# arn:aws:ssm:*:*:parameter/segment-builder/prod/* (see deploy docs).
set -euo pipefail

ENV_FILE=/opt/elasticbeanstalk/deployment/custom_env_vars
PARAM_PREFIX="/segment-builder/prod"

# Start fresh each deploy -- otherwise every previous deploy's lines pile up
# here too, since nothing else ever truncates this file.
: > "$ENV_FILE"

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)
echo "fetching secrets from SSM under ${PARAM_PREFIX}/* in region ${REGION}"

# Secrets live in SSM, not here, by design -- only the parameter NAMES are
# listed. Add a name here once you've created the matching SecureString
# parameter; anything not created in SSM is silently skipped (matches this
# app's existing "unset = feature disabled" convention for optional secrets).
SECRET_NAMES=(
  SECRET_KEY
  DATABASE_URL
  SEGMENT_TOKEN_ENCRYPTION_KEYS
  SEGMENT_CATALOG_TOKEN
  AIRTABLE_API_KEY
  GOOGLE_OAUTH_CLIENT_SECRET
)

for name in "${SECRET_NAMES[@]}"; do
  err_file=$(mktemp)
  # The `if` guards this against `set -e`: a failing command substitution
  # inside an `if` condition doesn't abort the script, so one missing
  # optional secret doesn't take down every secret after it in the list.
  if value=$(aws ssm get-parameter \
    --name "${PARAM_PREFIX}/${name}" \
    --with-decryption \
    --region "$REGION" \
    --query 'Parameter.Value' \
    --output text 2>"$err_file"); then
    # The file is sourced by a shell, so a value is escaped for a double-quoted string:
    # an unescaped `$(...)`, backtick or quote in a parameter would otherwise run as code
    # (or break every later source of the file) at the next deploy.
    escaped=${value//\\/\\\\}
    escaped=${escaped//\"/\\\"}
    escaped=${escaped//\$/\\\$}
    escaped=${escaped//\`/\\\`}
    echo "export ${name}=\"${escaped}\"" >> "$ENV_FILE"
    echo "fetched ${name}"
  else
    # Safe to log: on failure this is an AWS CLI/API error message
    # (e.g. ParameterNotFound, AccessDenied), never the secret value itself.
    echo "WARN: could not fetch ${PARAM_PREFIX}/${name}: $(cat "$err_file")" >&2
  fi
  rm -f "$err_file"
done
