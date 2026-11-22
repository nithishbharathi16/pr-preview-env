# PR Preview Environments

Automatically spins up a live, short-lived preview environment for every
GitHub pull request, posts the link back on the PR, and tears the
environment down on its own after a TTL (or immediately on PR close).

## Why

Reviewers can click a live link instead of pulling a branch locally to test
it. The system also demonstrates event-driven orchestration, resource
lifecycle management, and cost-control guardrails around ephemeral infra.

## Architecture

```
GitHub PR event --> API Gateway --> Request Handler (Lambda)
                                         |
                                         v
                                  SQS: provision-queue
                                         |
                                         v
                              Provisioner (Lambda) --> EC2 instance
                                         |                  |
                                         v                  v
                               DynamoDB (env state)   app boots, runs
                                         ^
                                         |
                      Health Checker (Lambda, scheduled) -- polls instance
                                         |
                                         v
                               SNS: notifications --> Notifier (Lambda)
                                                            |
                                                            v
                                                   GitHub PR comment

   EventBridge (every 5 min) --> Reaper (Lambda) --> terminates expired
                                        ^                envs, drains
                                        |                teardown-queue
                                SQS: teardown-queue
                                        ^
                                        |
                        Request Handler enqueues on PR "closed"
```

### Components

| Component | Role |
|---|---|
| API Gateway | Receives the GitHub webhook |
| Request Handler (Lambda) | Validates webhook signature, enqueues provision/teardown jobs, enforces the concurrency cap |
| SQS provision-queue / teardown-queue (+ DLQs) | Decouple webhook receipt from slow EC2 operations; failed jobs land in a DLQ after 3 retries instead of vanishing |
| Provisioner (Lambda) | Launches a tagged EC2 instance running the PR's branch, writes initial DynamoDB state |
| Health Checker (Lambda, scheduled) | Polls provisioning environments until the app responds, marks READY or FAILED |
| Reaper (Lambda, scheduled) | Terminates environments past TTL, drains explicit teardown requests on PR close |
| Notifier (Lambda) | Subscribed to SNS, posts status updates as GitHub PR comments |
| DynamoDB | Single source of truth for environment state, keyed by `pr_id` |
| SNS | Fans out status events (ready / failed / terminated) to the notifier |
| S3 | Reserved for storing provisioning logs / build configs |
| CloudWatch | Lambda logs + alarms (wire up alarms on DLQ depth and Reaper/HealthChecker errors) |
| IAM | Per-function least-privilege roles; EC2 termination is scoped to instances tagged `pr-preview=true` |

### DynamoDB schema (`pr-preview-environments`)

```
pr_id (PK)      e.g. "my-org/my-repo#42"
sk (SK)         "ENV"
status          PROVISIONING | READY | FAILED | TERMINATED
instance_id
public_url
repo, branch, sha
created_at      epoch ms
expires_at      epoch seconds (DynamoDB TTL attribute)
```

GSI `status-index` (partition key `status`) lets the Request Handler count
active environments to enforce `MAX_CONCURRENT_ENVIRONMENTS`.

## Guardrails built in

- Hard cap on concurrent environments (`MAX_CONCURRENT_ENVIRONMENTS`, default 5) — new PRs get a 429 until one frees up
- TTL-based auto-teardown (default 60 min) plus immediate teardown on PR close
- Dead-letter queues on both SQS queues so failed provision/teardown jobs are visible, not silently dropped
- Webhook signature verification (HMAC SHA-256) so the public endpoint can't be triggered by arbitrary requests
- EC2 termination is IAM-scoped to instances tagged `pr-preview=true`, so the Reaper can't touch unrelated infra

## Prerequisites

- AWS account with the CDK bootstrapped (`cdk bootstrap`)
- Node.js 20+
- A VPC subnet + security group for the preview EC2 instances (the security
  group must allow inbound on your app's port, e.g. 3000)
- A GitHub repo you control, to register the webhook against
- (Optional) a GitHub personal access token with `repo` scope, if you want
  the Notifier to post PR comments

## Setup

1. Install dependencies and bundle each Lambda:
   ```bash
   npm install
   ./scripts/install-lambda-deps.sh
   ```

2. Set required environment variables before deploying (or hardcode via
   CDK context — see `lib/pr-preview-env-stack.js`):
   - `PREVIEW_SUBNET_ID`
   - `PREVIEW_SECURITY_GROUP_ID`
   - `PREVIEW_AMI_ID` (defaults to a placeholder Amazon Linux 2023 AMI —
     replace with one valid in your region)
   - `GITHUB_WEBHOOK_SECRET` (set on the Request Handler Lambda after first
     deploy, or wire in via CDK)
   - `GITHUB_TOKEN` (set on the Notifier Lambda if you want PR comments)

3. Deploy:
   ```bash
   npx cdk deploy
   ```
   This creates real, billable AWS resources (EC2 instances, Lambda, API
   Gateway, DynamoDB, SQS, SNS). Review the stack's cost implications before
   deploying, and tear it down with `npx cdk destroy` when you're done
   demoing.

4. Copy the `WebhookUrl` output and register it as a webhook on your GitHub
   repo (Settings → Webhooks), subscribed to "Pull requests" events, with
   the same secret as `GITHUB_WEBHOOK_SECRET`.

## Known simplifications (documented on purpose)

- `RunInstances` IAM permission uses `resources: ["*"]` because fine-grained
  resource-level restriction for `RunInstances` requires constraining the
  AMI/subnet/security-group sub-resources via a launch template — noted here
  rather than silently over-scoped.
- The Health Checker uses a DynamoDB `Scan` for simplicity; at real scale,
  swap for a query against the `status-index` GSI.
- The sample app start command (`npm start`) assumes a Node.js app; adjust
  `buildUserData` in `lambdas/provisioner/index.js` for other stacks.

## Repo layout

```
bin/                  CDK app entry point
lib/                  CDK stack definition
lambdas/
  request-handler/    Webhook receiver, signature verification, enqueue
  provisioner/         Launches EC2, writes initial DynamoDB record
  health-checker/      Scheduled: polls provisioning envs, marks READY/FAILED
  reaper/              Scheduled: TTL sweep + explicit teardown
  notifier/             SNS subscriber, posts GitHub PR comments
scripts/              Helper scripts (dependency install, user-data reference)
```
