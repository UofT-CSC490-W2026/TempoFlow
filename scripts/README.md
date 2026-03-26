## TempoFlow AWS/CDK workflow

Use these scripts to refresh credentials and deploy the `TempoFlow-Infra-<stage>` stack. Session tokens from SSO expire roughly every hour, so rerun the setup whenever you see `ExpiredToken` errors.

### 1. Refresh sandbox credentials
1. Grab a fresh Access Key, Secret, and Session Token from the AWS sandbox portal.
2. Feed them into the helper script (from repo root):
   ```bash
   AWS_ACCESS_KEY_ID=... \
   AWS_SECRET_ACCESS_KEY=... \
   AWS_SESSION_TOKEN=... \
   ./scripts/setup_aws_env.sh
   ```
   This writes the values into the shared profile `tempo-sandbox` and confirms with `aws sts get-caller-identity`.

### 2. Export variables for this terminal session
```bash
export AWS_PROFILE=tempo-sandbox
export AWS_DEFAULT_REGION=us-east-1          # change if you deploy elsewhere
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile ${AWS_PROFILE})
```

### 3. Deploy infrastructure
```bash
./scripts/deploy_infra.sh dev    # or "prod" for STAGE=prod
```
What the script does:
1. Installs deps + builds the CDK TypeScript app.
2. Runs `cdk bootstrap` (safe to repeat).
3. Runs `STAGE=<arg> cdk deploy`.

To also deploy the **optional** Next.js stack (`TempoFlow-Web-<stage>` — Fargate + ALB), set `DEPLOY_WEB_STACK=1` when running the deploy script (requires Docker because CDK builds the `web-app/` container image locally):

```bash
DEPLOY_WEB_STACK=1 ./scripts/deploy_infra.sh dev
```

To deploy the web app with **AWS Amplify Hosting** (no local Docker required), set:

```bash
export AMPLIFY_GITHUB_REPO="owner/repo"
export AMPLIFY_GITHUB_BRANCH="main"   # optional
export AMPLIFY_GITHUB_ACCESS_TOKEN="ghp_..."         # classic PAT (do not commit; do not paste in chat)
DEPLOY_AMPLIFY_WEB_STACK=1 ./scripts/deploy_infra.sh dev
```

Amplify will pull/build automatically using the PAT passed as a NoEcho CloudFormation parameter.

See `A2/infrastructure/README.md` for details.

### 4. Verify in AWS console
- CloudFormation → Stack `TempoFlow-Infra-<stage>` should be `CREATE_COMPLETE`/`UPDATE_COMPLETE`.
- Outputs tab lists the bucket + table names to plug into pipelines/web app.

### 5. Which generator scripts are canonical?
- Canonical Part 3 pipeline implementations live under `A2/pipelines/`:
   - `A2/pipelines/video data processing/`
   - `A2/pipelines/Audio data processing/`
- The standalone files in `scripts/` (`generate_audio_validation_data.py`, `generate_dancer_validation_data.py`) are optional helper experiments and are not required for Part 4 IaC grading.
- For A2 writeup/demo, prefer running pipeline code from `A2/pipelines/` and use bucket names from CloudFormation outputs.

### Notes for teammates
- Only one person per account/region needs to bootstrap the first time; everyone else can just deploy.
- If you don’t plan to change infra, you can skip deploy and just read the CloudFormation outputs.
- Remember to remove any temporary credentials from shell history or `.env` files.
