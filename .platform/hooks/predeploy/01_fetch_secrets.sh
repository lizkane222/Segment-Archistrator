#!/bin/bash
# Pulls secrets out of SSM Parameter Store and appends them to the env file EB
# sources before starting gunicorn, so they never sit in plaintext EB
# environment properties (visible to anyone with EB console/CLI read access).
#
# Requires the EB EC2 instance role to have ssm:GetParameter on
# arn:aws:ssm:*:*:parameter/segment-builder/prod/* (see deploy docs).
set -euo pipefail

ENV_FILE=/opt/elasticbeanstalk/deployment/env
PARAM_PREFIX="/segment-builder/prod"

TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
REGION=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/placement/region)

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
)

for name in "${SECRET_NAMES[@]}"; do
  value=$(aws ssm get-parameter \
    --name "${PARAM_PREFIX}/${name}" \
    --with-decryption \
    --region "$REGION" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null) || continue

  if [ -n "$value" ]; then
    echo "export ${name}=\"${value}\"" >> "$ENV_FILE"
  fi
done
