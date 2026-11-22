const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

function postGithubComment(repo, prNumber, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ body });
    const req = https.request(
      {
        hostname: "api.github.com",
        path: `/repos/${repo}/issues/${prNumber}/comments`,
        method: "POST",
        headers: {
          "User-Agent": "pr-preview-env-bot",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve(res.statusCode));
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function messageFor(event) {
  switch (event.event) {
    case "ENV_READY":
      return `✅ Preview environment is ready: ${event.url}`;
    case "ENV_TERMINATED":
      return `🗑️ Preview environment was torn down (${event.reason}).`;
    case "PROVISION_FAILED":
      return `❌ Failed to provision preview environment: ${event.error}`;
    case "PROVISION_TIMEOUT":
      return `⏱️ Preview environment took too long to come up and was marked failed (instance ${event.instance_id}).`;
    default:
      return `Preview environment update: ${JSON.stringify(event)}`;
  }
}

/**
 * Subscribed to the SNS notifications topic. Formats each event as a
 * GitHub PR comment. Swap this out for Slack/email if you don't want to
 * wire up a GitHub token.
 */
exports.handler = async (snsEvent) => {
  for (const record of snsEvent.Records) {
    const payload = JSON.parse(record.Sns.Message);
    const [repo, prNumber] = (payload.pr_id || "").split("#");
    const body = messageFor(payload);

    console.log(`Notification for ${payload.pr_id}: ${body}`);

    if (GITHUB_TOKEN && repo && prNumber) {
      await postGithubComment(repo, prNumber, body).catch((err) =>
        console.error("Failed to post GitHub comment:", err)
      );
    }
  }
};
