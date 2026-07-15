import { awscdk, javascript, github } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'yicr',
  authorAddress: 'yicr@users.noreply.github.com',
  cdkVersion: '2.232.0',
  defaultReleaseBranch: 'main',
  typescriptVersion: '6.0.x',
  jsiiVersion: '6.0.x',
  name: 'rds-database-running-scheduler',
  packageManager: javascript.NodePackageManager.NPM,
  projenrcTs: true,
  repositoryUrl: 'https://github.com/gammarers-aws-cdk-constructs/rds-database-running-scheduler.git',
  description: 'This AWS CDK construct controls the start and stop of RDS DB instances and Aurora clusters based on resource tags. EventBridge Scheduler invokes a durable Lambda function on a cron schedule so databases run only during defined working hours. The Lambda discovers tagged resources account-wide via the Resource Groups Tagging API, deduplicates Aurora cluster member instances when the parent cluster is also tagged, and controls each remaining resource using the region encoded in its ARN. Default schedule: start 07:50 UTC, stop 19:05 UTC, Monday–Friday.',
  keywords: [
    'cdk',
    'aws',
    'schedule',
    'rds',
    'database',
    'aurora',
    'cluster',
    'instance',
  ],
  deps: [],
  devDeps: [
    '@aws/durable-execution-sdk-js@^1.1.7',
    '@aws-sdk/client-cost-explorer@^3.1087.0',
    '@aws-sdk/client-lambda@^3.1087.0',
    '@aws-sdk/client-rds@^3.1087.0',
    '@aws-sdk/client-resource-groups-tagging-api@^3.1087.0',
    '@slack/web-api@^6.13.0',
    '@types/aws-lambda@^8.10.162',
    'aws-lambda-secret-fetcher@^0.6.2',
    'aws-sdk-client-mock@^2.2.0',
    'aws-sdk-client-mock-jest@^2.2.0',
    'strict-env-resolver@^0.5.2',
  ],
  releaseToNpm: true,
  npmTrustedPublishing: true,
  npmAccess: javascript.NpmAccess.PUBLIC,
  minNodeVersion: '20.0.0',
  workflowNodeVersion: '24.x',
  depsUpgradeOptions: {
    workflowOptions: {
      labels: ['auto-approve', 'auto-merge'],
      schedule: javascript.UpgradeDependenciesSchedule.WEEKLY,
    },
  },
  githubOptions: {
    projenCredentials: github.GithubCredentials.fromApp({
      permissions: {
        pullRequests: github.workflows.AppPermission.WRITE,
        contents: github.workflows.AppPermission.WRITE,
        workflows: github.workflows.AppPermission.WRITE,
      },
    }),
  },
  autoApproveOptions: {
    allowedUsernames: [
      'gammarers-projen-upgrade-bot[bot]',
      'yicr',
    ],
  },
  jestOptions: {
    extraCliOptions: ['--silent'],
  },
  tsconfigDev: {
    compilerOptions: {
      strict: true,
    },
  },
  lambdaOptions: {
    // target node.js runtime
    runtime: awscdk.LambdaRuntime.NODEJS_24_X,
    bundlingOptions: {
      // list of node modules to exclude from the bundle
      externals: ['@aws-sdk/*'],
      sourcemap: true,
    },
  },
});
project.addPackageIgnore('/.devcontainer');
project.synth();