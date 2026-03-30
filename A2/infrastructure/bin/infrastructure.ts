#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { InfrastructureStack } from '../lib/infrastructure-stack';
import { WebAppStack } from '../lib/web-app-stack';
import { AmplifyWebAppStack } from '../lib/amplify-web-app-stack';
import { A5BackendStack } from '../lib/a5-backend-stack';

const app = new cdk.App();

// Get the stage from environment variable, default to 'dev'
const stage = process.env.STAGE || 'dev';
const stackName = `TempoFlow-Infra-${stage}`;
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT || process.env.AWS_ACCOUNT_ID,
  region: process.env.CDK_DEFAULT_REGION || process.env.AWS_DEFAULT_REGION,
};

const infra = new InfrastructureStack(app, stackName, {
  stackName: stackName,
  stage,
  env,
  description: `TempoFlow Infrastructure for stage: ${stage}`,
});

// Next.js web app (ECS Fargate + ALB). Opt-in — set DEPLOY_WEB_STACK=1 (adds ALB + Fargate cost).
if (process.env.DEPLOY_WEB_STACK === '1') {
  new WebAppStack(app, `TempoFlow-Web-${stage}`, {
    stackName: `TempoFlow-Web-${stage}`,
    stage,
    userVideoBucket: infra.userVideoBucket,
    env,
    description: `TempoFlow web app (Fargate) for stage: ${stage}`,
  });
}

// Next.js web app on AWS Amplify Hosting (no local Docker required).
// Opt-in — set DEPLOY_AMPLIFY_WEB_STACK=1. Pass a GitHub classic PAT at deploy time (NoEcho parameter).
if (process.env.DEPLOY_AMPLIFY_WEB_STACK === '1') {
  const githubRepo = process.env.AMPLIFY_GITHUB_REPO ?? '';
  const githubBranch = process.env.AMPLIFY_GITHUB_BRANCH ?? 'main';

  new AmplifyWebAppStack(app, `TempoFlow-AmplifyWeb-${stage}`, {
    stackName: `TempoFlow-AmplifyWeb-${stage}`,
    stage,
    githubRepo,
    githubBranch,
    env,
    description: `TempoFlow web app (Amplify Hosting) for stage: ${stage}`,
  });
}

// A5 FastAPI on Elastic Beanstalk (CDK zips A5/ to S3). Opt-in — set DEPLOY_A5_BACKEND_STACK=1. No Docker, no CodeConnections.
if (process.env.DEPLOY_A5_BACKEND_STACK === '1') {
  new A5BackendStack(app, `TempoFlow-A5Backend-${stage}`, {
    stackName: `TempoFlow-A5Backend-${stage}`,
    stage,
    env,
    description: `TempoFlow A5 API (Elastic Beanstalk) for stage: ${stage}`,
  });
}
