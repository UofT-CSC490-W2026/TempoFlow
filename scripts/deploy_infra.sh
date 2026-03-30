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

STACKS=("TempoFlow-Infra-${STAGE}")
PARAMS=()

if [ "${DEPLOY_WEB_STACK:-0}" = "1" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: Docker is required when DEPLOY_WEB_STACK=1 (CDK builds the web-app image locally)." >&2
    echo "Use DEPLOY_AMPLIFY_WEB_STACK=1 for frontend hosting without Docker, or install Docker Desktop." >&2
    exit 1
  fi
fi

if [ "${DEPLOY_WEB_STACK:-0}" = "1" ]; then
  STACKS+=("TempoFlow-Web-${STAGE}")
fi

if [ "${DEPLOY_AMPLIFY_WEB_STACK:-0}" = "1" ]; then
  : "${AMPLIFY_GITHUB_REPO:?Set AMPLIFY_GITHUB_REPO to 'owner/repo'}"
  : "${AMPLIFY_GITHUB_ACCESS_TOKEN:?Set AMPLIFY_GITHUB_ACCESS_TOKEN (GitHub PAT classic) for Amplify}"
  STACKS+=("TempoFlow-AmplifyWeb-${STAGE}")
  PARAMS+=(--parameters "TempoFlow-AmplifyWeb-${STAGE}:GitHubAccessToken=${AMPLIFY_GITHUB_ACCESS_TOKEN}")
fi

if [ "${DEPLOY_A5_BACKEND_STACK:-0}" = "1" ]; then
  : "${GEMINI_API_KEY:?Set GEMINI_API_KEY for A5 backend (NoEcho parameter; do not commit)}"

  # Platform names are region-specific and versioned; never hardcode. Prefer A5_EB_SOLUTION_STACK, else query AWS.
  A5_EB_STACK="${A5_EB_SOLUTION_STACK:-}"
  if [ -z "${A5_EB_STACK}" ]; then
    AWS_CLI_EXTRA=()
    [ -n "${AWS_PROFILE:-}" ] && AWS_CLI_EXTRA+=(--profile "${AWS_PROFILE}")
    q12="SolutionStacks[?contains(@, 'Amazon Linux 2023') && contains(@, 'Python 3.12')] | [0]"
    q11="SolutionStacks[?contains(@, 'Amazon Linux 2023') && contains(@, 'Python 3.11')] | [0]"
    qpy="SolutionStacks[?contains(@, 'Amazon Linux 2023') && contains(@, 'Python 3')] | [0]"
    A5_EB_STACK=$(aws elasticbeanstalk list-available-solution-stacks "${AWS_CLI_EXTRA[@]}" --region "${AWS_DEFAULT_REGION}" --query "${q12}" --output text 2>/dev/null || true)
    if [ -z "${A5_EB_STACK}" ] || [ "${A5_EB_STACK}" = "None" ]; then
      A5_EB_STACK=$(aws elasticbeanstalk list-available-solution-stacks "${AWS_CLI_EXTRA[@]}" --region "${AWS_DEFAULT_REGION}" --query "${q11}" --output text 2>/dev/null || true)
    fi
    if [ -z "${A5_EB_STACK}" ] || [ "${A5_EB_STACK}" = "None" ]; then
      A5_EB_STACK=$(aws elasticbeanstalk list-available-solution-stacks "${AWS_CLI_EXTRA[@]}" --region "${AWS_DEFAULT_REGION}" --query "${qpy}" --output text 2>/dev/null || true)
    fi
  fi
  if [ -z "${A5_EB_STACK}" ] || [ "${A5_EB_STACK}" = "None" ]; then
    echo "ERROR: Could not resolve an Elastic Beanstalk solution stack in ${AWS_DEFAULT_REGION}." >&2
    echo "Set A5_EB_SOLUTION_STACK to the full name from:" >&2
    echo "  aws elasticbeanstalk list-available-solution-stacks --region ${AWS_DEFAULT_REGION} --output text | grep 'Amazon Linux 2023' | grep Python" >&2
    exit 1
  fi
  echo "Using Elastic Beanstalk solution stack: ${A5_EB_STACK}"

  STACKS+=("TempoFlow-A5Backend-${STAGE}")
  PARAMS+=(--parameters "TempoFlow-A5Backend-${STAGE}:GeminiApiKey=${GEMINI_API_KEY}")
  PARAMS+=(--parameters "TempoFlow-A5Backend-${STAGE}:EbSolutionStack=${A5_EB_STACK}")
fi

export STAGE="${STAGE}"
npx cdk deploy "${STACKS[@]}" "${PARAMS[@]}"
