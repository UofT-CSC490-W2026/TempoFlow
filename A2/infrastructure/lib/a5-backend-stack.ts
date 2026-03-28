import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { Construct } from 'constructs';

export interface A5BackendStackProps extends cdk.StackProps {
  stage: string;
}

/**
 * A5 FastAPI on **Elastic Beanstalk** (Python platform).
 * CDK uploads a **zip of `A5/`** to S3 during deploy — no GitHub/CodeStar/CodeConnections and **no Docker**.
 *
 * Pass `GeminiApiKey` as a NoEcho CloudFormation parameter. Pass `EbSolutionStack` (full platform name for
 * your **region**); `./scripts/deploy_infra.sh` resolves it automatically via the AWS CLI when unset.
 */
export class A5BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: A5BackendStackProps) {
    super(scope, id, props);

    const { stage } = props;

    const geminiApiKey = new cdk.CfnParameter(this, 'GeminiApiKey', {
      type: 'String',
      noEcho: true,
      description: 'Google Gemini API key (GEMINI_API_KEY) for A5 move-feedback and related features.',
    });

    const solutionStack = new cdk.CfnParameter(this, 'EbSolutionStack', {
      type: 'String',
      description:
        'Exact Elastic Beanstalk solution stack name in this region (changes when AWS updates platforms). deploy_infra.sh sets this via list-available-solution-stacks unless A5_EB_SOLUTION_STACK is set.',
    });

    const a5Path = path.join(__dirname, '..', '..', '..', 'A5');

    const serviceRole = new iam.Role(this, 'A5EbServiceRole', {
      assumedBy: new iam.ServicePrincipal('elasticbeanstalk.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSElasticBeanstalkService'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSElasticBeanstalkEnhancedHealth'),
      ],
    });

    const instanceRole = new iam.Role(this, 'A5EbInstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkWebTier'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSElasticBeanstalkWorkerTier'),
      ],
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'A5EbInstanceProfile', {
      roles: [instanceRole.roleName],
    });
    instanceProfile.node.addDependency(instanceRole);

    const asset = new s3assets.Asset(this, 'A5SourceBundle', {
      path: a5Path,
    });
    asset.grantRead(serviceRole);

    const ebApp = new elasticbeanstalk.CfnApplication(this, 'A5EbApplication', {
      applicationName: `tempoflow-a5-${stage}`,
      description: 'TempoFlow A5 FastAPI (alignment / EBS / overlays)',
    });

    // CloudFormation no longer accepts VersionLabel on ApplicationVersion; Ref returns the generated label.
    const appVersion = new elasticbeanstalk.CfnApplicationVersion(this, 'A5EbAppVersion', {
      applicationName: ebApp.applicationName!,
      description: `Bundle hash ${asset.assetHash}`,
      sourceBundle: {
        s3Bucket: asset.s3BucketName,
        s3Key: asset.s3ObjectKey,
      },
    });
    appVersion.node.addDependency(asset);
    appVersion.node.addDependency(ebApp);

    const envName = `tf-a5-${stage}`.replace(/[^a-zA-Z0-9-]/g, '-');
    const ebEnv = new elasticbeanstalk.CfnEnvironment(this, 'A5EbEnvironment', {
      applicationName: ebApp.applicationName!,
      environmentName: envName.slice(0, 40),
      solutionStackName: solutionStack.valueAsString,
      versionLabel: appVersion.ref,
      tier: { name: 'WebServer', type: 'Standard', version: '1.0' },
      optionSettings: [
        {
          namespace: 'aws:elasticbeanstalk:environment',
          optionName: 'EnvironmentType',
          value: 'SingleInstance',
        },
        {
          namespace: 'aws:elasticbeanstalk:environment',
          optionName: 'ServiceRole',
          value: serviceRole.roleArn,
        },
        {
          namespace: 'aws:autoscaling:launchconfiguration',
          optionName: 'IamInstanceProfile',
          value: instanceProfile.ref,
        },
        {
          namespace: 'aws:autoscaling:launchconfiguration',
          optionName: 'InstanceType',
          value: 't3.large',
        },
        {
          namespace: 'aws:elasticbeanstalk:application:environment',
          optionName: 'GEMINI_API_KEY',
          value: geminiApiKey.valueAsString,
        },
        {
          namespace: 'aws:elasticbeanstalk:application:environment',
          optionName: 'PYTHONUNBUFFERED',
          value: '1',
        },
      ],
    });
    ebEnv.node.addDependency(appVersion);

    new cdk.CfnOutput(this, 'A5BackendStage', { value: stage });
    new cdk.CfnOutput(this, 'A5EbEndpointUrl', {
      value: ebEnv.attrEndpointUrl,
      description: 'HTTP URL for the A5 API (use with web-app EBS_BACKEND_URL + NEXT_PUBLIC_EBS_PROXY if frontend is HTTPS)',
    });
    new cdk.CfnOutput(this, 'A5BackendBaseUrl', {
      value: ebEnv.attrEndpointUrl,
      description: 'Same as endpoint — http://… elasticbeanstalk or single-instance URL',
    });
    new cdk.CfnOutput(this, 'A5ProcessorUrl', {
      value: cdk.Fn.join('', [ebEnv.attrEndpointUrl, '/api/process']),
      description: 'Full /api/process URL (HTTP)',
    });
  }
}
