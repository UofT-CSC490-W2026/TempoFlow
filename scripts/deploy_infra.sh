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
WEB_STACK_ENABLED="${DEPLOY_WEB_STACK:-0}"
AMPLIFY_STACK_ENABLED="${DEPLOY_AMPLIFY_WEB_STACK:-0}"

if [ "${WEB_STACK_ENABLED}" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker is required for DEPLOY_WEB_STACK=1 (CDK builds the web container image from web-app/)." >&2
    echo "Install Docker Desktop (macOS) and re-run:" >&2
    echo "  export AWS_PROFILE=tempo-sandbox" >&2
    echo "  export AWS_DEFAULT_REGION=us-east-1" >&2
    echo "  export AWS_ACCOUNT_ID=... " >&2
    echo "  DEPLOY_WEB_STACK=1 ./scripts/deploy_infra.sh ${STAGE}" >&2
    exit 1
  fi
  STAGE="${STAGE}" npx cdk deploy "TempoFlow-Infra-${STAGE}" "TempoFlow-Web-${STAGE}"
elif [ "${AMPLIFY_STACK_ENABLED}" = "1" ]; then
  : "${AMPLIFY_GITHUB_REPO:?Set AMPLIFY_GITHUB_REPO to 'owner/repo'}"
  : "${AMPLIFY_GITHUB_ACCESS_TOKEN:?Set AMPLIFY_GITHUB_ACCESS_TOKEN (GitHub PAT classic) for Amplify}"
  STAGE="${STAGE}" npx cdk deploy "TempoFlow-Infra-${STAGE}" "TempoFlow-AmplifyWeb-${STAGE}" \
    --parameters "TempoFlow-AmplifyWeb-${STAGE}:GitHubAccessToken=${AMPLIFY_GITHUB_ACCESS_TOKEN}"
else
  STAGE="${STAGE}" npx cdk deploy "TempoFlow-Infra-${STAGE}"
fi