#!/usr/bin/env bash
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE first}"
: "${AWS_DEFAULT_REGION:?Set AWS_DEFAULT_REGION first}"
: "${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID first}"

STAGE="${1:-dev}"

cd "$(dirname "${BASH_SOURCE[0]}")/../A2/infrastructure"

npm install
npm run build

echo "Bootstrapping (safe to rerun)..."
npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_DEFAULT_REGION}"

echo "Deploying stage '${STAGE}'..."
STAGE="${STAGE}" npx cdk deploy