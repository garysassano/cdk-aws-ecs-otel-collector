import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import {
  Cluster,
  Compatibility,
  ContainerImage,
  Protocol as EcsProtocol,
  FargateService,
  LogDriver,
  TaskDefinition,
} from "aws-cdk-lib/aws-ecs";
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  Protocol,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket } from "aws-cdk-lib/aws-s3";
import {
  BucketDeployment,
  Source as S3Source,
} from "aws-cdk-lib/aws-s3-deployment";
import {
  CfnPullThroughCacheRule,
  CfnRegistryPolicy,
  Repository,
} from "aws-cdk-lib/aws-ecr";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { join } from "path";
import { validateEnv } from "../utils/validate-env";

/**
 * Prefix required for ECR pull-through cache secrets in AWS Secrets Manager.
 * @see https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache-creating-rule.html#cache-rule-prereq
 */
const ECR_PULL_THROUGH_CACHE_PREFIX = "ecr-pullthroughcache/";

// Required environment variables
const env = validateEnv([
  "DOCKERHUB_USERNAME",
  "DOCKERHUB_ACCESS_TOKEN",
  "HONEYCOMB_API_KEY",
]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    //==============================================================================
    // OTELCONTRIB ECR REPO (DOCKERHUB PULL-THROUGH CACHE)
    //==============================================================================

    const dhCacheRuleSecret = new Secret(this, "DhCacheRuleSecret", {
      secretName: `${ECR_PULL_THROUGH_CACHE_PREFIX}dockerhub`,
      secretStringValue: SecretValue.unsafePlainText(
        JSON.stringify({
          username: env.DOCKERHUB_USERNAME,
          accessToken: env.DOCKERHUB_ACCESS_TOKEN,
        }),
      ),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const ecsAccessRole = new Role(this, "EcsAccessRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    const dhCacheRule = new CfnPullThroughCacheRule(this, "DhCacheRule", {
      ecrRepositoryPrefix: "dockerhub",
      upstreamRegistry: "docker-hub",
      upstreamRegistryUrl: "registry-1.docker.io",
      credentialArn: dhCacheRuleSecret.secretArn,
    });

    const dhCacheRegistryPolicy = new CfnRegistryPolicy(
      this,
      "DhCacheRegistryPolicy",
      {
        policyText: {
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowDockerhubCache",
              Effect: "Allow",
              Principal: { AWS: ecsAccessRole.roleArn },
              Action: ["ecr:CreateRepository", "ecr:BatchImportUpstreamImage"],
              Resource: `arn:aws:ecr:${this.region}:${this.account}:repository/${dhCacheRule.ecrRepositoryPrefix}/*`,
            },
          ],
        },
      },
    );

    const ecrOtelcontribRepo = new Repository(this, "EcrOtelcontribRepo", {
      repositoryName: `${dhCacheRule.ecrRepositoryPrefix}/otel/opentelemetry-collector-contrib`,
      removalPolicy: RemovalPolicy.DESTROY,
      emptyOnDelete: true,
    });

    //==============================================================================
    // ECS CLUSTER WITH ALB
    //==============================================================================

    // VPC and Network
    const vpc = new ec2.Vpc(this, "MyVpc", { maxAzs: 2 });
    const cluster = new Cluster(this, "OtelCollectorCluster", { vpc });

    // S3 Bucket for OpenTelemetry Config
    const otelConfigBucket = new Bucket(this, "OtelConfigBucket", {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    new BucketDeployment(this, "DeployOtelConfig", {
      sources: [S3Source.asset(join(__dirname, "..", "otel"))],
      destinationBucket: otelConfigBucket,
    });

    // Task Role and Definition
    const taskRole = new Role(this, "OtelCollectorTaskRole", {
      assumedBy: new ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    otelConfigBucket.addToResourcePolicy(
      new PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [otelConfigBucket.arnForObjects("*")],
        principals: [taskRole],
      }),
    );

    const taskDefinition = new TaskDefinition(this, "OtelCollectorTaskDef", {
      compatibility: Compatibility.FARGATE,
      cpu: "512",
      memoryMiB: "1024",
      taskRole,
    });

    taskDefinition.addContainer("otel-collector", {
      image: ContainerImage.fromEcrRepository(ecrOtelcontribRepo),
      command: [
        "--config",
        `s3://${otelConfigBucket.bucketName}.s3.${this.region}.amazonaws.com/collector-confmap.yml`,
      ],
      environment: {
        HONEYCOMB_API_KEY: env.HONEYCOMB_API_KEY,
      },
      portMappings: [
        {
          containerPort: 4318,
          hostPort: 4318,
          protocol: EcsProtocol.TCP,
          name: "otlp",
        },
        {
          containerPort: 13133,
          hostPort: 13133,
          protocol: EcsProtocol.TCP,
          name: "healthcheck",
        },
      ],
      healthCheck: {
        command: ["CMD", "/healthcheck"],
        timeout: Duration.seconds(10),
        startPeriod: Duration.seconds(10),
        retries: 3,
        interval: Duration.seconds(30),
      },
      logging: LogDriver.awsLogs({
        streamPrefix: "/ecs/otel-collector",
        logRetention: RetentionDays.ONE_WEEK,
      }),
    });

    // Load Balancer and Target Group
    const alb = new ApplicationLoadBalancer(this, "OtelCollectorALB", {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener("OtlpListener", {
      port: 4318,
      protocol: ApplicationProtocol.HTTP,
    });

    // Fargate Service
    const service = new FargateService(this, "OtelCollectorService", {
      cluster,
      taskDefinition,
      desiredCount: 2,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheckGracePeriod: Duration.seconds(60),
    });

    // Create target using service's loadBalancerTarget
    const otlpTarget = service.loadBalancerTarget({
      containerName: "otel-collector",
      containerPort: 4318,
      protocol: EcsProtocol.TCP,
    });

    listener.addTargets("OtlpTarget", {
      port: 4318,
      protocol: ApplicationProtocol.HTTP,
      targets: [otlpTarget],
      healthCheck: {
        path: "/",
        port: "13133",
        protocol: Protocol.HTTP,
        healthyHttpCodes: "200",
      },
      deregistrationDelay: Duration.seconds(10),
    });

    // Security Group Rules
    service.connections.allowFrom(
      alb,
      ec2.Port.tcp(4318),
      "Allow ALB to access OTel Collector OTLP endpoint",
    );
    service.connections.allowFrom(
      alb,
      ec2.Port.tcp(13133),
      "Allow ALB to access OTel Collector healthcheck endpoint",
    );

    // Debug Instance
    const debugInstanceSg = new ec2.SecurityGroup(this, "DebugInstanceSg", {
      vpc,
      description: "Security group for debug EC2 instance",
      allowAllOutbound: true,
    });

    const debugInstanceRole = new Role(this, "DebugInstanceRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });

    const debugInstance = new ec2.Instance(this, "DebugInstance", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      securityGroup: debugInstanceSg,
      role: debugInstanceRole,
    });

    debugInstanceSg.connections.allowTo(
      alb,
      ec2.Port.tcp(4318),
      "Allow access to ALB OTLP endpoint",
    );

    // Ensure the registry policy is created before the service tries to pull images.
    service.node.addDependency(dhCacheRegistryPolicy);

    // Outputs
    new CfnOutput(this, "OtelCollectorServiceUrl", {
      value: `http://${alb.loadBalancerDnsName}:4318`,
    });

    new CfnOutput(this, "DebugInstanceId", {
      value: debugInstance.instanceId,
      description: "ID of the debug EC2 instance",
    });
  }
}
