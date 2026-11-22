const { EC2Client, RunInstancesCommand } = require("@aws-sdk/client-ec2");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const ec2 = new EC2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;
const TTL_MINUTES = Number(process.env.ENVIRONMENT_TTL_MINUTES || 60);

// Replace with an AMI that has your runtime baked in, or use user-data to
// install it. Amazon Linux 2023 shown as a placeholder.
const AMI_ID = process.env.PREVIEW_AMI_ID || "ami-0c101f26f147fa7fd";
const INSTANCE_TYPE = process.env.PREVIEW_INSTANCE_TYPE || "t3.micro";
const SUBNET_ID = process.env.PREVIEW_SUBNET_ID;
const SECURITY_GROUP_ID = process.env.PREVIEW_SECURITY_GROUP_ID;

function buildUserData(repo, branch, sha) {
  const script = `#!/bin/bash
set -euxo pipefail
dnf install -y git nodejs
cd /home/ec2-user
git clone --branch ${branch} --depth 1 https://github.com/${repo}.git app
cd app
git checkout ${sha}
npm install --omit=dev
nohup npm start > /var/log/preview-app.log 2>&1 &
`;
  return Buffer.from(script).toString("base64");
}

exports.handler = async (event) => {
  for (const record of event.Records) {
    const job = JSON.parse(record.body);
    const { pr_id, repo, branch, sha } = job;

    try {
      const result = await ec2.send(
        new RunInstancesCommand({
          ImageId: AMI_ID,
          InstanceType: INSTANCE_TYPE,
          MinCount: 1,
          MaxCount: 1,
          SubnetId: SUBNET_ID,
          SecurityGroupIds: SECURITY_GROUP_ID ? [SECURITY_GROUP_ID] : undefined,
          UserData: buildUserData(repo, branch, sha),
          TagSpecifications: [
            {
              ResourceType: "instance",
              Tags: [
                { Key: "pr-preview", Value: "true" },
                { Key: "pr-id", Value: pr_id },
                { Key: "Name", Value: `pr-preview-${pr_id}` },
              ],
            },
          ],
          InstanceInitiatedShutdownBehavior: "terminate",
        })
      );

      const instanceId = result.Instances[0].InstanceId;
      const now = Date.now();
      const expiresAt = Math.floor(now / 1000) + TTL_MINUTES * 60;

      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pr_id,
            sk: "ENV",
            status: "PROVISIONING",
            instance_id: instanceId,
            repo,
            branch,
            sha,
            created_at: now,
            expires_at: expiresAt,
          },
        })
      );
    } catch (err) {
      console.error(`Failed to provision environment for ${pr_id}:`, err);
      await sns.send(
        new PublishCommand({
          TopicArn: NOTIFICATIONS_TOPIC_ARN,
          Subject: `Provisioning failed: ${pr_id}`,
          Message: JSON.stringify({ pr_id, error: String(err), event: "PROVISION_FAILED" }),
        })
      );
      // Rethrow so SQS retries, and eventually routes to the DLQ after maxReceiveCount.
      throw err;
    }
  }
};
