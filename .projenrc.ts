import { awscdk, javascript } from "projen";

const project = new awscdk.AwsCdkTypeScriptApp({
  cdkVersion: "2.177.0",
  defaultReleaseBranch: "main",
  depsUpgradeOptions: { workflow: false },
  devDeps: ["zod"],
  eslint: true,
  name: "cdk-aws-apprunner-dockerhub-cache",
  packageManager: javascript.NodePackageManager.PNPM,
  pnpmVersion: "9",
  prettier: true,
  projenrcTs: true,

  deps: ["@aws-cdk/aws-apprunner-alpha"],
});

project.synth();
