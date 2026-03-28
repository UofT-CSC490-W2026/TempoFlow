import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import { Construct } from 'constructs';

/** Amplify branch URLs use a DNS-safe label (slashes and other chars are not valid in subdomains). */
function amplifyBranchSubdomain(branch: string): string {
  const s = branch
    .trim()
    .toLowerCase()
    .replace(/\//g, '-')
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s.length > 0 ? s : 'app';
}

export interface AmplifyWebAppStackProps extends cdk.StackProps {
  stage: string;
  /**
   * GitHub repository in the form "owner/repo".
   * Example: "yehyunlee/TempoFlow"
   */
  githubRepo: string;
  /**
   * Branch to deploy from.
   * Example: "main"
   */
  githubBranch: string;
}

/**
 * AWS Amplify Hosting for the Next.js app in `web-app/`.
 *
 * No Docker is required locally because Amplify builds in AWS.
 * Note: For GitHub, CloudFormation uses `AccessToken` (PAT). We pass it via a NoEcho parameter at deploy time.
 */
export class AmplifyWebAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AmplifyWebAppStackProps) {
    super(scope, id, props);

    const { stage, githubRepo, githubBranch } = props;


    const repoParts = githubRepo.split('/');
    if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
      throw new Error(`githubRepo must be "owner/repo" (got: ${githubRepo})`);
    }
    const [owner, repo] = repoParts;
    const branchSubdomain = amplifyBranchSubdomain(githubBranch);

    const githubAccessToken = new cdk.CfnParameter(this, 'GitHubAccessToken', {
      type: 'String',
      noEcho: true,
      description: 'GitHub Personal Access Token (classic) with admin:repo_hook + public_repo (or repo).',
    });

    // Monorepo build spec required when AMPLIFY_MONOREPO_APP_ROOT is set.
    const buildSpecYaml = [
      'version: 1',
      'applications:',
      '  - appRoot: web-app',
      '    frontend:',
      '      phases:',
      '        preBuild:',
      '          commands:',
      '            - npm install',
      '        build:',
      '          commands:',
      '            - npm run build',
      '      artifacts:',
      '        baseDirectory: .next',
      '        files:',
      '          - "**/*"',
      '      cache:',
      '        paths:',
      '          - node_modules/**/*',
      '          - .next/cache/**/*',
      '',
    ].join('\n');

    const app = new amplify.CfnApp(this, 'AmplifyApp', {
      name: `tempoflow-web-${stage}`,
      repository: `https://github.com/${owner}/${repo}`,
      // For GitHub repos, CloudFormation expects AccessToken (not OauthToken).
      accessToken: githubAccessToken.valueAsString,
      platform: 'WEB_COMPUTE',
      buildSpec: buildSpecYaml,
      environmentVariables: [
        { name: 'AMPLIFY_MONOREPO_APP_ROOT', value: 'web-app' },
        { name: 'NEXT_PUBLIC_APP_STORAGE_MODE', value: 'local' },
        { name: 'NEXT_PUBLIC_APP_ANALYSIS_MODE', value: 'local' },
      ],
    });

    const branch = new amplify.CfnBranch(this, 'AmplifyBranch', {
      appId: app.attrAppId,
      branchName: githubBranch,
      stage: stage === 'prod' ? 'PRODUCTION' : 'DEVELOPMENT',
      enableAutoBuild: true,
    });

    new cdk.CfnOutput(this, 'AmplifyStage', { value: stage });
    new cdk.CfnOutput(this, 'AmplifyRepo', { value: githubRepo });
    new cdk.CfnOutput(this, 'AmplifyBranchOutput', { value: githubBranch });
    new cdk.CfnOutput(this, 'AmplifyAppId', { value: app.attrAppId });
    new cdk.CfnOutput(this, 'AmplifyBranchUrl', {
      value: `https://${branchSubdomain}.${app.attrDefaultDomain}`,
      description:
        'Amplify-hosted URL after first successful build (branch name sanitized for DNS, e.g. feat/be-hosting → feat-be-hosting)',
    });
    new cdk.CfnOutput(this, 'AmplifyDefaultDomain', { value: app.attrDefaultDomain });
    new cdk.CfnOutput(this, 'AmplifyBranchName', { value: branch.branchName });
  }
}

