const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");
const http = require("http");

const ec2 = new EC2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;
const APP_PORT = Number(process.env.PREVIEW_APP_PORT || 3000);
const MAX_PROVISIONING_MINUTES = 10;

function checkHttp(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/", timeout: timeoutMs }, (res) => {
      resolve(res.statusCode < 500);
      res.resume();
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Invoked on a schedule. Scans environments still in PROVISIONING state,
 * checks whether the instance is up and the app is responding, and either
 * marks it READY (publishing a notification) or FAILED if it's stuck past
 * MAX_PROVISIONING_MINUTES.
 */
exports.handler = async () => {
  const { Items = [] } = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "#s = :provisioning",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":provisioning": "PROVISIONING" },
    })
  );

  for (const env of Items) {
    const ageMinutes = (Date.now() - env.created_at) / 60000;

    const { Reservations } = await ec2.send(
      new DescribeInstancesCommand({ InstanceIds: [env.instance_id] })
    );
    const instance = Reservations?.[0]?.Instances?.[0];
    const publicIp = instance?.PublicIpAddress;

    const isHealthy = publicIp ? await checkHttp(publicIp, APP_PORT) : false;

    if (isHealthy) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pr_id: env.pr_id, sk: "ENV" },
          UpdateExpression: "SET #s = :ready, public_url = :url",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: {
            ":ready": "READY",
            ":url": `http://${publicIp}:${APP_PORT}`,
          },
        })
      );
      await sns.send(
        new PublishCommand({
          TopicArn: NOTIFICATIONS_TOPIC_ARN,
          Subject: `Environment ready: ${env.pr_id}`,
          Message: JSON.stringify({
            pr_id: env.pr_id,
            event: "ENV_READY",
            url: `http://${publicIp}:${APP_PORT}`,
          }),
        })
      );
    } else if (ageMinutes > MAX_PROVISIONING_MINUTES) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pr_id: env.pr_id, sk: "ENV" },
          UpdateExpression: "SET #s = :failed",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":failed": "FAILED" },
        })
      );
      await sns.send(
        new PublishCommand({
          TopicArn: NOTIFICATIONS_TOPIC_ARN,
          Subject: `Environment stuck: ${env.pr_id}`,
          Message: JSON.stringify({
            pr_id: env.pr_id,
            event: "PROVISION_TIMEOUT",
            instance_id: env.instance_id,
          }),
        })
      );
    }
  }
};
