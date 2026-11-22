const cdk = require("aws-cdk-lib");
const { Stack, Duration, RemovalPolicy } = cdk;
const apigw = require("aws-cdk-lib/aws-apigateway");
const lambda = require("aws-cdk-lib/aws-lambda");
const sqs = require("aws-cdk-lib/aws-sqs");
const sns = require("aws-cdk-lib/aws-sns");
const subs = require("aws-cdk-lib/aws-sns-subscriptions");
const ddb = require("aws-cdk-lib/aws-dynamodb");
const iam = require("aws-cdk-lib/aws-iam");
const events = require("aws-cdk-lib/aws-events");
const targets = require("aws-cdk-lib/aws-events-targets");
const lambdaEventSources = require("aws-cdk-lib/aws-lambda-event-sources");

const MAX_CONCURRENT_ENVIRONMENTS = 5;
const ENVIRONMENT_TTL_MINUTES = 60;

class PrPreviewEnvStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // ---------- Data layer ----------
    const environmentsTable = new ddb.Table(this, "EnvironmentsTable", {
      tableName: "pr-preview-environments",
      partitionKey: { name: "pr_id", type: ddb.AttributeType.STRING },
      sortKey: { name: "sk", type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expires_at",
      removalPolicy: RemovalPolicy.DESTROY,
    });
    environmentsTable.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.KEYS_ONLY,
    });

    // ---------- Messaging layer ----------
    const provisionDlq = new sqs.Queue(this, "ProvisionDlq", {
      queueName: "pr-preview-provision-dlq",
      retentionPeriod: Duration.days(14),
    });

    const provisionQueue = new sqs.Queue(this, "ProvisionQueue", {
      queueName: "pr-preview-provision-queue",
      visibilityTimeout: Duration.seconds(300),
      deadLetterQueue: { queue: provisionDlq, maxReceiveCount: 3 },
    });

    const teardownDlq = new sqs.Queue(this, "TeardownDlq", {
      queueName: "pr-preview-teardown-dlq",
      retentionPeriod: Duration.days(14),
    });

    const teardownQueue = new sqs.Queue(this, "TeardownQueue", {
      queueName: "pr-preview-teardown-queue",
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: teardownDlq, maxReceiveCount: 3 },
    });

    const notificationsTopic = new sns.Topic(this, "NotificationsTopic", {
      topicName: "pr-preview-notifications",
    });
    // Subscribe your own email for alerts during development.
    // notificationsTopic.addSubscription(new subs.EmailSubscription("you@example.com"));

    // ---------- Artifact storage ----------
    const configBucket = new cdk.aws_s3.Bucket(this, "ConfigBucket", {
      bucketName: `pr-preview-config-${this.account}-${this.region}`,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: cdk.aws_s3.BlockPublicAccess.BLOCK_ALL,
    });

    // ---------- Shared Lambda env vars ----------
    const commonEnv = {
      TABLE_NAME: environmentsTable.tableName,
      PROVISION_QUEUE_URL: provisionQueue.queueUrl,
      TEARDOWN_QUEUE_URL: teardownQueue.queueUrl,
      NOTIFICATIONS_TOPIC_ARN: notificationsTopic.topicArn,
      CONFIG_BUCKET: configBucket.bucketName,
      MAX_CONCURRENT_ENVIRONMENTS: String(MAX_CONCURRENT_ENVIRONMENTS),
      ENVIRONMENT_TTL_MINUTES: String(ENVIRONMENT_TTL_MINUTES),
    };

    const makeFn = (id, handlerPath) =>
      new lambda.Function(this, id, {
        functionName: `pr-preview-${id.toLowerCase()}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        handler: "index.handler",
        code: lambda.Code.fromAsset(handlerPath),
        timeout: Duration.seconds(30),
        environment: commonEnv,
      });

    // ---------- Lambdas ----------
    const requestHandlerFn = makeFn("RequestHandler", "lambdas/request-handler");
    const provisionerFn = makeFn("Provisioner", "lambdas/provisioner");
    provisionerFn.timeout = Duration.seconds(120);
    const healthCheckerFn = makeFn("HealthChecker", "lambdas/health-checker");
    const reaperFn = makeFn("Reaper", "lambdas/reaper");
    const notifierFn = makeFn("Notifier", "lambdas/notifier");

    // ---------- Permissions (least privilege) ----------
    environmentsTable.grantReadWriteData(requestHandlerFn);
    environmentsTable.grantReadWriteData(provisionerFn);
    environmentsTable.grantReadWriteData(healthCheckerFn);
    environmentsTable.grantReadWriteData(reaperFn);
    environmentsTable.grantReadData(notifierFn);

    provisionQueue.grantSendMessages(requestHandlerFn);
    provisionQueue.grantConsumeMessages(provisionerFn);
    teardownQueue.grantSendMessages(reaperFn);
    teardownQueue.grantConsumeMessages(reaperFn);

    notificationsTopic.grantPublish(healthCheckerFn);
    notificationsTopic.grantPublish(reaperFn);
    notificationsTopic.grantPublish(provisionerFn);
    notificationsTopic.addSubscription(new subs.LambdaSubscription(notifierFn));

    configBucket.grantRead(provisionerFn);

    provisionerFn.addEventSource(
      new lambdaEventSources.SqsEventSource(provisionQueue, { batchSize: 1 })
    );

    // Scope EC2 permissions tightly: only instances tagged by this system.
    const ec2TagCondition = {
      StringEquals: { "aws:RequestTag/pr-preview": "true" },
    };
    provisionerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:RunInstances"],
        resources: ["*"], // RunInstances requires resource-level + tag conditions on sub-resources; see README for tightening via launch template.
      })
    );
    provisionerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:CreateTags"],
        resources: ["*"],
        conditions: ec2TagCondition,
      })
    );
    provisionerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus"],
        resources: ["*"],
      })
    );
    reaperFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:TerminateInstances"],
        resources: ["*"],
        conditions: { StringEquals: { "ec2:ResourceTag/pr-preview": "true" } },
      })
    );
    healthCheckerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ec2:DescribeInstances"],
        resources: ["*"],
      })
    );

    // ---------- API Gateway (GitHub webhook entry point) ----------
    const api = new apigw.RestApi(this, "WebhookApi", {
      restApiName: "pr-preview-webhook",
      deployOptions: { stageName: "prod" },
    });
    const webhook = api.root.addResource("webhook");
    webhook.addMethod("POST", new apigw.LambdaIntegration(requestHandlerFn));

    // ---------- Scheduled Reaper ----------
    new events.Rule(this, "ReaperSchedule", {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(reaperFn)],
    });

    // ---------- Outputs ----------
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${api.url}webhook`,
      description: "Set this as the GitHub webhook payload URL",
    });
    new cdk.CfnOutput(this, "TableName", { value: environmentsTable.tableName });
  }
}

module.exports = { PrPreviewEnvStack };
