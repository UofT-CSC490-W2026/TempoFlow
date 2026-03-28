# TempoFlow A2 Infrastructure (Part 4)

This folder contains the Infrastructure as Code (IaC) for your project using AWS CDK.

## What this infrastructure code does

It creates cloud resources that your Part 3 pipelines use:

- S3 buckets for datasets and generated validation artifacts
- DynamoDB tables for app/session metadata

So this is **not separate** from Part 3. Think of it as:

- Part 3 = pipeline logic (Python code that processes data)
- Part 4 = cloud foundation (where those pipelines store/read data)

If Part 3 is "how data is processed," Part 4 is "where it lives and how environments are managed."

## Resources provisioned

- 4 S3 buckets
  - User uploads
  - Reference videos
  - Video validation artifacts
  - Audio validation datasets/artifacts
- 2 DynamoDB tables
  - Users table
  - Sessions table

### Optional: Next.js web app (`web-app/`) on ECS Fargate

For course requirements that ask for **infrastructure as code**, this repo already satisfies that: **AWS CDK** compiles to **CloudFormation** (`cdk synth` prints stack templates you can archive or submit).

The optional stack **`TempoFlow-Web-<stage>`** (see `lib/web-app-stack.ts`) provisions:

- A small VPC (public subnets only, no NAT gateway)
- An ECS cluster and **Fargate** service running the Next.js **standalone** Docker image from `web-app/`
- An **Application Load Balancer** with a public HTTP URL

It is **opt-in** so routine `cdk deploy` does not create billable load balancer capacity by surprise.

- Enable the web stack: set **`DEPLOY_WEB_STACK=1`** when you run `cdk deploy` or `cdk synth`.
- Skip it (S3 + DynamoDB only): omit the variable or set **`DEPLOY_WEB_STACK=0`**.

The web task receives **`USER_VIDEO_BUCKET_NAME`** and an IAM role that can read/write the user video bucket from `InfrastructureStack`, so `/api/upload` can use the **ECS task role** (no static `AWS_ACCESS_KEY_ID` in the container). Local development can still use access keys in `.env.local`.

## Environments (`dev` and `prod`)

Environment is controlled by `STAGE`.

- `dev` (for testing)
  - Faster iteration
  - Data can be destroyed with stack
- `prod` (for demonstration / DR)
  - Safer defaults (`RETAIN`)
  - DynamoDB Point-in-Time Recovery enabled
  - Public access blocked

Stack names:

- `TempoFlow-Infra-dev`
- `TempoFlow-Infra-prod`
- `TempoFlow-Web-dev` / `TempoFlow-Web-prod` (only when `DEPLOY_WEB_STACK=1`)
- `TempoFlow-AmplifyWeb-dev` / `TempoFlow-AmplifyWeb-prod` (only when `DEPLOY_AMPLIFY_WEB_STACK=1`)

## Command runbook (copy-paste)

### 0) One-time machine setup

Run once per machine.

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow/A2/infrastructure
npm install
```

What it does:

- Installs CDK/TypeScript dependencies for this infra project.

---

### 1) Set AWS env in terminal session

Run every new terminal session (or whenever credentials expire).

```bash
export AWS_PROFILE=tempo-sandbox
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile ${AWS_PROFILE})
```

What it does:

- Tells CDK which AWS account/region/profile to use.

If you need to refresh temporary credentials first:

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... AWS_SESSION_TOKEN=... ./scripts/setup_aws_env.sh
```

This helper is optional but useful when sandbox tokens expire.

---

### 2) Bootstrap CDK (one-time per account+region)

Usually once per AWS account+region.

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow/A2/infrastructure
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_DEFAULT_REGION}
```

What it does:

- Creates CDK support resources required before deploy.

---

### 3) Deploy dev environment

Run whenever infrastructure changes, or first-time deploy.

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow/A2/infrastructure
npm run build
STAGE=dev npx cdk deploy
```

What it does:

- Compiles CDK app and deploys stack `TempoFlow-Infra-dev`.

To also deploy the **Next.js web app** (ECS Fargate + ALB), opt in and have **Docker** available (CDK builds `web-app/` into a container image locally):

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow
DEPLOY_WEB_STACK=1 ./scripts/deploy_infra.sh dev
```

CloudFormation outputs include **`WebUrl`** (HTTP URL to the load balancer). First deploy can take several minutes while the container image builds and pushes.

To deploy the **Next.js web app with AWS Amplify Hosting** (no local Docker required), opt in and provide your GitHub repo + a GitHub classic PAT at deploy time:

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow
export AMPLIFY_GITHUB_REPO="owner/repo"
export AMPLIFY_GITHUB_BRANCH="main"                 # optional
export AMPLIFY_GITHUB_ACCESS_TOKEN="ghp_..."         # classic PAT (do not commit; do not paste in chat)

DEPLOY_AMPLIFY_WEB_STACK=1 ./scripts/deploy_infra.sh dev
```

After the stack is created, Amplify will start pulling and building the app; CloudFormation outputs include the Amplify URL.

Shortcut helper (optional):

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow
./scripts/deploy_infra.sh dev
```

---

### 4) Deploy prod environment

Run when you are ready for Part 5 DR demo / production-like environment.

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow/A2/infrastructure
npm run build
STAGE=prod npx cdk deploy
```

What it does:

- Deploys stack `TempoFlow-Infra-prod` with safer settings.

---

### 5) Verify outputs (bucket/table names)

Run after each deploy.

```bash
aws cloudformation describe-stacks \
  --stack-name TempoFlow-Infra-dev \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

What it does:

- Prints actual resource names to wire into Part 3 pipeline commands.

---

### 6) Diff / tests / synth (safe checks)

Run before deploy (recommended), especially for PR/demo/final submission.

Recommended order:

1. `npm run test`
2. `STAGE=<env> npx cdk diff`
3. `STAGE=<env> npx cdk synth`
4. `STAGE=<env> npx cdk deploy`

Use `<env>` as `dev` or `prod`.

```bash
cd /Users/yehyunlee/Documents/Repositories/TempoFlow/A2/infrastructure
npm run test
STAGE=dev npx cdk diff
STAGE=dev npx cdk synth > /tmp/tempoflow-dev.yaml
STAGE=prod npx cdk synth > /tmp/tempoflow-prod.yaml
```

What each does:

- `npm run test`: validates IaC expectations
- `cdk diff`: shows what will change before deploy
- `cdk synth`: generates CloudFormation templates

## Part 3 integration commands (copy-paste)

First set bucket variables from CloudFormation outputs.

### Quick copy-paste (end-to-end)

Use this when you want minimal typing. It resolves bucket names automatically.

```bash
# 0) Ensure AWS auth comes from profile (avoids stale key env vars)
export AWS_PROFILE=tempo-sandbox
export AWS_DEFAULT_REGION=us-east-1
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
aws sts get-caller-identity --profile "$AWS_PROFILE"

# 1) Choose environment
STACK=TempoFlow-Infra-dev
# STACK=TempoFlow-Infra-prod

# 2) Resolve bucket names from CloudFormation outputs
VIDEO_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ValidationVideoBucketName'].OutputValue" --output text)
AUDIO_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='AudioValidationBucketName'].OutputValue" --output text)
echo "Using VIDEO_BUCKET=$VIDEO_BUCKET"
echo "Using AUDIO_BUCKET=$AUDIO_BUCKET"

# 3) Video pipeline (S3 upload mode)
cd "/Users/yehyunlee/Documents/Repositories/TempoFlow/A2/pipelines/video data processing"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py generate --input ./input --to-s3

# NOTE: when prompted in the video script, paste VIDEO_BUCKET value shown above

# 4) Audio pipeline (verify datasets on S3)
cd "/Users/yehyunlee/Documents/Repositories/TempoFlow/A2/pipelines/Audio data processing"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python get_audio_files.py --mode aws --s3-bucket "$AUDIO_BUCKET" --aws-region "$AWS_DEFAULT_REGION"

# 5) Audio pipeline (generate validation outputs in S3)
python generate_validation_data.py --mode aws --num-pairs 100 --s3-bucket "$AUDIO_BUCKET" --s3-output-prefix output/run1/ --aws-region "$AWS_DEFAULT_REGION"
```

When to run this block:

- Reuse as many times as needed when generating new validation data batches.
- Re-run bucket-resolve lines whenever you switch `dev/prod` or re-create stacks.

What each section does:

- Step 2: maps infra outputs to shell vars so you avoid manual copy mistakes.
- Step 3: generates and uploads video validation set.
- Step 4: checks audio datasets are present in S3.
- Step 5: generates audio validation pairs + manifest in S3.

### A) Load bucket names into shell variables

Run after infra deploy (repeat only when stack/resources change).

```bash
STACK=TempoFlow-Infra-dev
VIDEO_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='ValidationVideoBucketName'].OutputValue" --output text)
AUDIO_BUCKET=$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='AudioValidationBucketName'].OutputValue" --output text)
echo "VIDEO_BUCKET=$VIDEO_BUCKET"
echo "AUDIO_BUCKET=$AUDIO_BUCKET"
```

### B) Video pipeline: generate + upload validation videos to S3

Run when you want to create/update dancer validation dataset in cloud.

```bash
cd "/Users/yehyunlee/Documents/Repositories/TempoFlow/A2/pipelines/video data processing"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py generate --input ./input --to-s3
```

What it does:

- Prompts AWS credentials, then uploads reference/transformed videos and `test_cases.json` to your S3 bucket.

### C) Audio pipeline: verify datasets in S3

Run once after dataset upload, then occasionally to confirm bucket state.

```bash
cd "/Users/yehyunlee/Documents/Repositories/TempoFlow/A2/pipelines/Audio data processing"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python get_audio_files.py --mode aws --s3-bucket "$AUDIO_BUCKET"
```

What it does:

- Checks that GTZAN/DEMAND datasets exist in S3.

### D) Audio pipeline: generate validation pairs in S3 mode

Run whenever you want a new generated audio validation batch.

```bash
cd "/Users/yehyunlee/Documents/Repositories/TempoFlow/A2/pipelines/Audio data processing"
source .venv/bin/activate
python generate_validation_data.py --mode aws --num-pairs 100 --s3-bucket "$AUDIO_BUCKET" --s3-output-prefix output/run1/
```

What it does:

- Downloads required source subset from S3, generates degraded pairs, uploads results + manifest back to S3.

## Which scripts are optional?

- Optional helper wrappers:
  - `/scripts/setup_aws_env.sh`
  - `/scripts/deploy_infra.sh`
- Canonical pipeline implementations are under:
  - `/A2/pipelines/video data processing/`
  - `/A2/pipelines/Audio data processing/`

You can run everything manually without the helper scripts; they are mainly for convenience and team consistency.
