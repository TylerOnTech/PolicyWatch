#!/usr/bin/env bash
# Generates fresh application secrets and stores them as SSM SecureString parameters under
# /<project>/<environment>/. Run once per environment from your workstation (uses your AWS credentials).
# Values are generated locally, sent straight to SSM and never written to disk or printed.
#
#   infra/scripts/put-secrets.sh                # defaults: policywatch / demo / us-east-1
#   PROJECT=policywatch ENVIRONMENT=demo AWS_REGION=us-east-1 infra/scripts/put-secrets.sh
#   ROTATE=1 infra/scripts/put-secrets.sh      # overwrite existing values
set -euo pipefail

PROJECT="${PROJECT:-policywatch}"
ENVIRONMENT="${ENVIRONMENT:-demo}"
AWS_REGION="${AWS_REGION:-us-east-1}"
PREFIX="/${PROJECT}/${ENVIRONMENT}"
OVERWRITE=$([ "${ROTATE:-0}" = "1" ] && echo "--overwrite" || echo "--no-overwrite")

rand() { openssl rand -base64 48 | tr -d '/+=\n' | cut -c1-"$1"; }

put() {
  local name="$1" value="$2"
  if aws ssm put-parameter --region "$AWS_REGION" --name "${PREFIX}/${name}" --type SecureString \
      --value "$value" $OVERWRITE >/dev/null 2>&1; then
    echo "stored   ${PREFIX}/${name}"
  else
    echo "kept     ${PREFIX}/${name} (already exists; ROTATE=1 to replace)"
  fi
}

put ADMIN_API_KEY "$(rand 48)"
put READONLY_API_KEY "$(rand 48)"
put SECRET_ENCRYPTION_KEY "$(openssl rand -base64 32)"
put POSTGRES_PASSWORD "$(rand 32)"
put REDIS_PASSWORD "$(rand 32)"

echo
echo "Retrieve the admin API key when you need it:"
echo "  aws ssm get-parameter --region $AWS_REGION --with-decryption --name ${PREFIX}/ADMIN_API_KEY --query Parameter.Value --output text"
echo "Note: rotating SECRET_ENCRYPTION_KEY makes existing webhook secrets undecryptable; recreate subscriptions afterwards."
