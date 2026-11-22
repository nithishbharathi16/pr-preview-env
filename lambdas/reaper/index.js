const { EC2Client, TerminateInstancesCommand } = require("@aws-sdk/client-ec2");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  GetCommand,
} = require("@aws-sdk/lib-dynamodb");
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");
const { SNSClient, PublishCommand } = require("@aws-sdk/client-sns");

const ec2 = new EC2Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sqs = new SQSClient({});
const sns = new SNSClient({});

const TABLE_NAME = process.env.TABLE_NAME;
const TEARDOWN_QUEUE_URL = process.env.TEARDOWN_QUEUE_URL;
const NOTIFICATIONS_TOPIC_ARN = process.env.NOTIFICATIONS_TOPIC_ARN;

async function terminateEnvironment(prId, reason) {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { pr_id: prId, sk: "ENV" } })
  );
  if (!Item || Item.status === "TERMINATED") return;

  if (Item.instance_id) {
    await ec2.send(
      new TerminateInstancesCommand({ InstanceIds: [Item.instance_id] })
    );
  }

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pr_id: prId, sk: "ENV" },
      UpdateExpression: "SET #s = :terminated",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":terminated": "TERMINATED" },
    })
  );

  await sns.send(
    new PublishCommand({
      TopicArn: NOTIFICATIONS_TOPIC_ARN,
      Subject: `Environment torn down: ${prId}`,
      Message: JSON.stringify({ pr_id: prId, event: "ENV_TERMINATED", reason }),
    })
  );
}

/**
 * Runs on a schedule. Two jobs:
 *  1. Drain the teardown queue (explicit requests, e.g. PR closed).
 *  2. Sweep DynamoDB for READY/PROVISIONING environments past their TTL.
 */
exports.handler = async () => {
  // 1. Explicit teardown requests
  const { Messages = [] } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: TEARDOWN_QUEUE_URL,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    })
  );
  for (const msg of Messages) {
    const { pr_id, reason } = JSON.parse(msg.Body);
    await terminateEnvironment(pr_id, reason);
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: TEARDOWN_QUEUE_URL,
        ReceiptHandle: msg.ReceiptHandle,
      })
    );
  }

  // 2. TTL sweep
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { Items = [] } = await ddb.send(
    new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression:
        "(#s = :ready OR #s = :provisioning) AND expires_at < :now",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: {
        ":ready": "READY",
        ":provisioning": "PROVISIONING",
        ":now": nowSeconds,
      },
    })
  );
  for (const env of Items) {
    await terminateEnvironment(env.pr_id, "ttl_expired");
  }
};
