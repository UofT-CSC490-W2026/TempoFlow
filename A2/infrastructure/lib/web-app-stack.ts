import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface WebAppStackProps extends cdk.StackProps {
  stage: string;
  /** User video bucket from InfrastructureStack — used for presigned uploads. */
  userVideoBucket: s3.IBucket;
}

/**
 * Next.js web app on ECS Fargate behind an Application Load Balancer.
 * Image is built from ../../web-app via CDK Docker asset (standalone output).
 */
export class WebAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WebAppStackProps) {
    super(scope, id, props);

    const { stage, userVideoBucket } = props;

    const webAppPath = path.join(__dirname, '..', '..', '..', 'web-app');

    const vpc = new ec2.Vpc(this, 'WebVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const cluster = new ecs.Cluster(this, 'WebCluster', {
      vpc,
      clusterName: `tempoflow-web-${stage}`,
    });

    const webService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'WebService', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      publicLoadBalancer: true,
      assignPublicIp: true,
      taskImageOptions: {
        image: ecs.ContainerImage.fromAsset(webAppPath, {
          file: 'Dockerfile',
          platform: Platform.LINUX_AMD64,
          buildArgs: {
            NEXT_PUBLIC_APP_STORAGE_MODE: 'aws',
            NEXT_PUBLIC_APP_ANALYSIS_MODE: 'local',
          },
        }),
        containerPort: 3000,
        environment: {
          AWS_REGION: this.region,
          USER_VIDEO_BUCKET_NAME: userVideoBucket.bucketName,
        },
      },
      healthCheckGracePeriod: cdk.Duration.seconds(90),
    });

    userVideoBucket.grantReadWrite(webService.taskDefinition.taskRole);

    new cdk.CfnOutput(this, 'WebStage', { value: stage });
    new cdk.CfnOutput(this, 'WebLoadBalancerDns', {
      value: webService.loadBalancer.loadBalancerDnsName,
      description: 'ALB DNS — open http://<dns>/ for the app',
    });
    new cdk.CfnOutput(this, 'WebUrl', {
      value: `http://${webService.loadBalancer.loadBalancerDnsName}`,
    });
  }
}
