#!/usr/bin/env node
const cdk = require("aws-cdk-lib");
const { PrPreviewEnvStack } = require("../lib/pr-preview-env-stack");

const app = new cdk.App();
new PrPreviewEnvStack(app, "PrPreviewEnvStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || "ap-southeast-2",
  },
});
