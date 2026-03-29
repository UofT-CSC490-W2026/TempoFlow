import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticbeanstalk from 'aws-cdk-lib/aws-elasticbeanstalk';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
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
 *
 * **VPC:** Many course/sandbox accounts have **no default VPC**. EB then fails creating security groups
 * (“GroupName is only supported for … default VPC”). This stack creates a small **public-subnet-only VPC**
 * (no NAT) and pins the environment to it — same idea as `WebAppStack`.
 */
export class A5BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: A5BackendStackProps) {
    super(scope, id, props);

    const { stage } = props;

    const vpc = new ec2.Vpc(this, 'A5EbVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

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

    // Asset uses IgnoreMode.GLOB by default — it does **not** read `.ebignore` or `.gitignore`.
    // Exclude local venv and dev artifacts or the bundle is ~1.4GB+ and fills disk / S3.
    const asset = new s3assets.Asset(this, 'A5SourceBundle', {
      path: a5Path,
      exclude: [
        'venv',
        '.venv',
        '__pycache__',
        '**/__pycache__/**',
        '.pytest_cache',
        'htmlcov',
        '.coverage',
        '.env',
        'tests',
        '*.md',
        '**/*.md',
        'profiling',
        '*.py[cod]',
        '**/*.py[cod]',
      ],
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
          namespace: 'aws:ec2:vpc',
          optionName: 'VPCId',
          value: vpc.vpcId,
        },
        {
          namespace: 'aws:ec2:vpc',
          optionName: 'Subnets',
          value: cdk.Fn.join(',', vpc.publicSubnets.map((s) => s.subnetId)),
        },
        {
          namespace: 'aws:ec2:vpc',
          optionName: 'AssociatePublicIpAddress',
          value: 'true',
        },
        {
          namespace: 'aws:elasticbeanstalk:environment',
          optionName: 'EnvironmentType',
          value: 'LoadBalanced',
        },
        {
          namespace: 'aws:elasticbeanstalk:environment',
          optionName: 'LoadBalancerType',
          value: 'application',
        },
        {
          namespace: 'aws:autoscaling:asg',
          optionName: 'MinSize',
          value: '2',
        },
        {
          namespace: 'aws:autoscaling:asg',
          optionName: 'MaxSize',
          value: '4',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'MeasureName',
          value: 'CPUUtilization',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'Statistic',
          value: 'Average',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'Unit',
          value: 'Percent',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'LowerThreshold',
          value: '30',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'UpperThreshold',
          value: '70',
        },
        {
          namespace: 'aws:autoscaling:trigger',
          optionName: 'BreachDuration',
          value: '2',
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
          namespace: 'aws:autoscaling:launchconfiguration',
          optionName: 'RootVolumeType',
          value: 'gp3',
        },
        {
          namespace: 'aws:autoscaling:launchconfiguration',
          optionName: 'RootVolumeSize',
          value: '24',
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
        // Predeploy hook installs static ffmpeg to /usr/local/bin; uvicorn often has a minimal PATH.
        {
          namespace: 'aws:elasticbeanstalk:application:environment',
          optionName: 'EBS_FFMPEG_PATH',
          value: '/usr/local/bin/ffmpeg',
        },
        {
          namespace: 'aws:elasticbeanstalk:application:environment',
          optionName: 'EBS_FFPROBE_PATH',
          value: '/usr/local/bin/ffprobe',
        },
      ],
    });
    ebEnv.node.addDependency(appVersion);

    const appName = ebApp.applicationName!;
    const envNameShort = envName.slice(0, 40);

    // Resolve EB HTTP hostname at deploy time (not exposed on CfnEnvironment) so we can front it with
    // HTTPS CloudFront. Browsers on Amplify (HTTPS) cannot call http://*.elasticbeanstalk.com (mixed
    // content); long /api/process calls also time out when proxied through Amplify (~30s). Direct
    // https://<cloudfront>/api/process avoids both issues (CORS is already allow_origins=* on A5).
    const ebCnameLookup = new AwsCustomResource(this, 'EbEnvironmentCnameLookup', {
      onCreate: {
        service: 'ElasticBeanstalk',
        action: 'describeEnvironments',
        parameters: {
          ApplicationName: appName,
          EnvironmentNames: [envNameShort],
        },
        physicalResourceId: PhysicalResourceId.of(`${envNameShort}-cname`),
      },
      onUpdate: {
        service: 'ElasticBeanstalk',
        action: 'describeEnvironments',
        parameters: {
          ApplicationName: appName,
          EnvironmentNames: [envNameShort],
        },
        physicalResourceId: PhysicalResourceId.of(`${envNameShort}-cname`),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
    ebCnameLookup.node.addDependency(ebEnv);

    const ebHttpHostname = ebCnameLookup.getResponseField('Environments.0.CNAME');

    const cfOrigin = new origins.HttpOrigin(ebHttpHostname, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      // CloudFormation rejects 180s for many accounts; custom-origin max is often 60s until quota increase.
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    const a5Distribution = new cloudfront.Distribution(this, 'A5EbHttpsDistribution', {
      comment: `HTTPS front for TempoFlow A5 EB (${stage}) — use for NEXT_PUBLIC_EBS_PROCESSOR_URL`,
      defaultBehavior: {
        origin: cfOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        compress: false,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
    });

    // AWS::ElasticBeanstalk::Environment no longer publishes EndpointURL/CNAME to Fn::GetAtt in the
    // CloudFormation schema used for this resource — stack outputs cannot reference them. The EB API
    // still returns CNAME; use the command below after the environment is healthy.
    new cdk.CfnOutput(this, 'A5BackendStage', { value: stage });
    new cdk.CfnOutput(this, 'A5EbApplicationName', { value: appName });
    new cdk.CfnOutput(this, 'A5EbEnvironmentName', { value: envNameShort });
    new cdk.CfnOutput(this, 'A5EbCnameLookupCommand', {
      value: cdk.Fn.sub(
        "aws elasticbeanstalk describe-environments --region ${AWS::Region} --application-name ${App} --environment-names ${Env} --query 'Environments[0].CNAME' --output text",
        { App: appName, Env: envNameShort },
      ),
      description:
        'EB HTTP hostname. Server-side env can use http://<host>; browsers should use stack output A5HttpsProcessorUrl (HTTPS).',
    });

    new cdk.CfnOutput(this, 'A5HttpsDistributionDomain', {
      value: a5Distribution.distributionDomainName,
      description: 'CloudFront domain (HTTPS). Set Amplify NEXT_PUBLIC_EBS_PROCESSOR_URL to https://<this>/api/process',
    });

    new cdk.CfnOutput(this, 'A5HttpsProcessorUrl', {
      value: cdk.Fn.join('', ['https://', a5Distribution.distributionDomainName, '/api/process']),
      description:
        'Preferred browser URL for EBS /api/process (HTTPS, long timeout vs Amplify proxy). Set NEXT_PUBLIC_EBS_PROCESSOR_URL to this; unset NEXT_PUBLIC_EBS_PROXY or set 0.',
    });
  }
}
