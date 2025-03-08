import { awscdk, javascript } from "projen";

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.182.0",
  defaultReleaseBranch: "main",
  depsUpgradeOptions: { workflow: false },
  devDeps: ["zod"],
  eslint: true,
  minNodeVersion: "22.14.0",
  name: "cdk-aws-ecs-otel-collector",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "9",
  prettier: true,
  projenrcTs: true,
});

project.synth();
