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

### 4. Verify in AWS console
- CloudFormation → Stack `TempoFlow-Infra-<stage>` should be `CREATE_COMPLETE`/`UPDATE_COMPLETE`.
- Outputs tab lists the bucket + table names to plug into pipelines/web app.

### Notes for teammates
- Only one person per account/region needs to bootstrap the first time; everyone else can just deploy.
- If you don’t plan to change infra, you can skip deploy and just read the CloudFormation outputs.
- Remember to remove any temporary credentials from shell history or `.env` files.