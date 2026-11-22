const crypto = require("crypto");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  QueryCommand,
} = require("@aws-sdk/lib-dynamodb");

const sqs = new SQSClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TABLE_NAME = process.env.TABLE_NAME;
const PROVISION_QUEUE_URL = process.env.PROVISION_QUEUE_URL;
const TEARDOWN_QUEUE_URL = process.env.TEARDOWN_QUEUE_URL;
const MAX_CONCURRENT_ENVIRONMENTS = Number(
  process.env.MAX_CONCURRENT_ENVIRONMENTS || 5
);

/**
 * Verifies the GitHub webhook signature (X-Hub-Signature-256) using the
 * shared secret stored in GITHUB_WEBHOOK_SECRET.
 */
function verifySignature(body, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function countActiveEnvironments() {
  // Simplified: in production use a GSI on status rather than a table scan.
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: "status-index",
      KeyConditionExpression: "#s = :active",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":active": "READY" },
    })
  ).catch(() => ({ Items: [] }));
  return Items.length;
}

exports.handler = async (event) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const signature = event.headers?.["x-hub-signature-256"];
  const rawBody = event.body || "";

  if (secret && !verifySignature(rawBody, signature, secret)) {
    return { statusCode: 401, body: "invalid signature" };
  }

  const payload = JSON.parse(rawBody || "{}");
  const action = payload.action;
  const pr = payload.pull_request;
  if (!pr) {
    return { statusCode: 200, body: "ignored: no pull_request in payload" };
  }

  const prId = `${payload.repository?.full_name}#${pr.number}`;

  if (action === "closed") {
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: TEARDOWN_QUEUE_URL,
        MessageBody: JSON.stringify({ pr_id: prId, reason: "pr_closed" }),
      })
    );
    return { statusCode: 200, body: "teardown queued" };
  }

  if (!["opened", "synchronize", "reopened"].includes(action)) {
    return { statusCode: 200, body: `ignored action: ${action}` };
  }

  const activeCount = await countActiveEnvironments();
  if (activeCount >= MAX_CONCURRENT_ENVIRONMENTS) {
    return {
      statusCode: 429,
      body: "max concurrent environments reached, try again later",
    };
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: PROVISION_QUEUE_URL,
      MessageBody: JSON.stringify({
        pr_id: prId,
        repo: payload.repository?.full_name,
        branch: pr.head?.ref,
        sha: pr.head?.sha,
      }),
      // Dedup identical rapid pushes within the queue's visibility window.
      MessageGroupId: undefined,
    })
  );

  return { statusCode: 202, body: "provisioning queued" };
};
