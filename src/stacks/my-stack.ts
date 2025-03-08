import { Service, Source } from "@aws-cdk/aws-apprunner-alpha";
import { RemovalPolicy, SecretValue, Stack, StackProps } from "aws-cdk-lib";
import {
  CfnPullThroughCacheRule,
  CfnRegistryPolicy,
  Repository,
} from "aws-cdk-lib/aws-ecr";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { validateEnv } from "../utils/validate-env";

/**
 * Prefix required for ECR pull-through cache secrets in AWS Secrets Manager.
 * @see https://docs.aws.amazon.com/AmazonECR/latest/userguide/pull-through-cache-creating-rule.html#cache-rule-prereq
 */
const ECR_PULL_THROUGH_CACHE_PREFIX = "ecr-pullthroughcache/";

// Required environment variables
const env = validateEnv(["DOCKERHUB_USERNAME", "DOCKERHUB_ACCESS_TOKEN"]);

export class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

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

    const apprunnerAccessRole = new Role(this, "ApprunnerAccessRole", {
      assumedBy: new ServicePrincipal("build.apprunner.amazonaws.com"),
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
              Principal: { AWS: apprunnerAccessRole.roleArn },
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

    const otelcontribService = new Service(this, "OtelcontribService", {
      accessRole: apprunnerAccessRole,
      source: Source.fromEcr({
        repository: ecrOtelcontribRepo,
        imageConfiguration: {
          port: 80,
        },
      }),
    });

    // Ensure the registry policy is created before the service tries to pull images.
    // Without this dependency, the App Runner service might fail to start if it attempts
    // to pull images before the ECR registry policy is in place.
    otelcontribService.node.addDependency(dhCacheRegistryPolicy);
  }
}
