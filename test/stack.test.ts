import { App, Stack, TimeZone } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { LambdaFailureDetection } from 'lambda-failure-detector';
import {
  RDSDatabaseRunningScheduleStack,
  SchedulingEnable,
  SlackNotificationEnable,
  WaitTimeoutNotification,
} from '../src';

const baseProps = {
  targetResource: {
    tagKey: 'WorkHoursRunning',
    tagValues: ['YES'],
  },
  notification: {
    slack: {
      enable: SlackNotificationEnable.ENABLED,
      secretName: 'example/slack/webhook',
    },
  },
};

/**
 * Asserts the wiring every stack shares, so each case only checks what it changes.
 *
 * - Both schedules invoke the `live` alias of the single durable Lambda and retry within one cron window.
 * - The Lambda has the durable execution settings.
 * - The log group is kept after creation succeeds, and deleted only when its creation fails.
 *
 * @param template Synthesized template of the stack under test.
 * @param state Expected `State` of both schedules.
 */
const expectSchedulerWiring = (template: Template, state: 'ENABLED' | 'DISABLED'): void => {
  template.resourceCountIs('AWS::Scheduler::Schedule', 2);
  template.resourceCountIs('AWS::Lambda::Function', 1);
  template.resourceCountIs('AWS::Lambda::Alias', 1);

  template.hasResourceProperties('AWS::Lambda::Function', {
    DurableConfig: {
      ExecutionTimeout: 7200,
      RetentionPeriodInDays: 1,
    },
  });
  template.hasResourceProperties('AWS::Lambda::Alias', { Name: 'live' });

  const [aliasLogicalId] = Object.keys(template.findResources('AWS::Lambda::Alias'));
  template.allResourcesProperties('AWS::Scheduler::Schedule', {
    State: state,
    FlexibleTimeWindow: {
      Mode: 'OFF',
    },
    Target: {
      Arn: { Ref: aliasLogicalId },
      RoleArn: Match.anyValue(),
      Input: Match.anyValue(),
      RetryPolicy: {
        MaximumEventAgeInSeconds: 7200,
        MaximumRetryAttempts: 2,
      },
    },
  });

  template.hasResource('AWS::Logs::LogGroup', {
    DeletionPolicy: 'RetainExceptOnCreate',
    UpdateReplacePolicy: 'Retain',
    Properties: Match.objectLike({
      RetentionInDays: 90,
    }),
  });
};

describe('RDSDatabaseRunningScheduleStack', () => {
  describe('default schedule with Slack', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', baseProps);
    const template = Template.fromStack(stack);

    it('Should have the shared scheduler wiring with ENABLED schedules', () => {
      expectSchedulerWiring(template, 'ENABLED');
    });

    it('Should use the default start and stop cron', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(50 7 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Etc/UTC',
      });
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(5 19 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Etc/UTC',
      });
    });

    it('Should describe RDS without resource-level restriction', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'RdsDescribe',
              Action: [
                'rds:DescribeDBInstances',
                'rds:DescribeDBClusters',
              ],
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        },
      });
    });

    it('Should scope RDS start/stop to tagged db and cluster ARNs', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'RdsRunningControl',
              Action: [
                'rds:StartDBInstance',
                'rds:StartDBCluster',
                'rds:StopDBInstance',
                'rds:StopDBCluster',
              ],
              Effect: 'Allow',
              Condition: {
                StringEquals: {
                  'aws:ResourceTag/WorkHoursRunning': ['YES'],
                },
              },
            }),
          ]),
        },
      });
      const policies = template.findResources('AWS::IAM::Policy');
      const serialized = JSON.stringify(policies);
      expect(serialized).toContain(':db:');
      expect(serialized).toContain(':cluster:');
      expect(serialized).toContain('aws:ResourceTag/WorkHoursRunning');
    });

    it('Should grant Secrets Manager read for Slack secret', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret',
              ],
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    it('Should set SLACK_SECRET_NAME on the Lambda', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            SLACK_SECRET_NAME: 'example/slack/webhook',
            WAIT_INTERVAL_SECONDS: '60',
            MAX_WAIT_SECONDS: '1800',
            NOTIFY_SLACK_ON_WAIT_TIMEOUT: 'true',
          }),
        },
      });
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('slack.enable true without Slack secret', () => {
    it('Should throw', () => {
      const app = new App();
      expect(() => {
        new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
          targetResource: baseProps.targetResource,
          notification: {
            slack: {
              enable: SlackNotificationEnable.ENABLED,
            },
          },
        });
      }).toThrow('notification.slack.secretName is required when notification.slack.enable is enabled');
    });
  });

  describe('without Slack notification', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      targetResource: baseProps.targetResource,
    });
    const template = Template.fromStack(stack);

    it('Should not grant Secrets Manager permissions', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain('secretsmanager:GetSecretValue');
      expect(serialized).not.toContain('secretsmanager:DescribeSecret');
    });

    it('Should not set SLACK_SECRET_NAME', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const serialized = JSON.stringify(functions);
      expect(serialized).not.toContain('SLACK_SECRET_NAME');
    });

    it('Should set default wait limits and disable timeout Slack notification', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            WAIT_INTERVAL_SECONDS: '60',
            MAX_WAIT_SECONDS: '1800',
            NOTIFY_SLACK_ON_WAIT_TIMEOUT: 'false',
          }),
        },
      });
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('slack.enable false with secretName', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      targetResource: baseProps.targetResource,
      notification: {
        slack: {
          enable: SlackNotificationEnable.DISABLED,
          secretName: 'example/slack/webhook',
        },
      },
    });
    const template = Template.fromStack(stack);

    it('Should not grant Secrets Manager permissions', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain('secretsmanager:GetSecretValue');
      expect(serialized).not.toContain('secretsmanager:DescribeSecret');
    });

    it('Should not set SLACK_SECRET_NAME', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const serialized = JSON.stringify(functions);
      expect(serialized).not.toContain('SLACK_SECRET_NAME');
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('slack.enable omitted defaults to false', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      targetResource: baseProps.targetResource,
      notification: {
        slack: {
          secretName: 'example/slack/webhook',
        },
      },
    });
    const template = Template.fromStack(stack);

    it('Should not grant Secrets Manager permissions', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      const serialized = JSON.stringify(policies);
      expect(serialized).not.toContain('secretsmanager:GetSecretValue');
      expect(serialized).not.toContain('secretsmanager:DescribeSecret');
    });

    it('Should not set SLACK_SECRET_NAME', () => {
      const functions = template.findResources('AWS::Lambda::Function');
      const serialized = JSON.stringify(functions);
      expect(serialized).not.toContain('SLACK_SECRET_NAME');
    });
  });

  describe('disabled scheduling', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      ...baseProps,
      enableScheduling: SchedulingEnable.DISABLED,
    });
    const template = Template.fromStack(stack);

    it('Should have the shared scheduler wiring with all Schedules DISABLED', () => {
      expectSchedulerWiring(template, 'DISABLED');
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('custom start/stop schedule', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      ...baseProps,
      enableScheduling: SchedulingEnable.ENABLED,
      startSchedule: {
        timezone: TimeZone.ASIA_TOKYO,
        minute: '55',
        hour: '8',
        week: 'MON-FRI',
      },
      stopSchedule: {
        timezone: TimeZone.ASIA_TOKYO,
        minute: '5',
        hour: '19',
        week: 'MON-FRI',
      },
    });
    const template = Template.fromStack(stack);

    it('Should have the shared scheduler wiring with ENABLED schedules', () => {
      expectSchedulerWiring(template, 'ENABLED');
    });

    it('Should use the custom start and stop cron in the given time zone', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(55 8 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        Target: Match.objectLike({
          Input: '{"Params":{"TagKey":"WorkHoursRunning","TagValues":["YES"],"Mode":"Start"}}',
        }),
      });
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(5 19 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Asia/Tokyo',
        Target: Match.objectLike({
          Input: '{"Params":{"TagKey":"WorkHoursRunning","TagValues":["YES"],"Mode":"Stop"}}',
        }),
      });
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('target regions', () => {
    it('Should search every enabled region by default', () => {
      const app = new App();
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', baseProps);
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TARGET_REGIONS: '[]',
          }),
        },
      });
    });

    it('Should pass the requested regions to the Lambda', () => {
      const app = new App();
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
        ...baseProps,
        targetRegions: ['ap-northeast-1', 'us-east-1'],
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            TARGET_REGIONS: '["ap-northeast-1","us-east-1"]',
          }),
        },
      });
    });

    it('Should allow listing the enabled regions without resource-level restriction', () => {
      const app = new App();
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', baseProps);
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'DescribeRegions',
              Action: 'ec2:DescribeRegions',
              Effect: 'Allow',
              Resource: '*',
            }),
          ]),
        },
      });
    });

    it.each([
      {
        name: 'is empty',
        targetRegions: [],
        message: 'targetRegions must not be empty when specified',
      },
      {
        name: 'contains a blank name',
        targetRegions: ['us-east-1', ' '],
        message: 'targetRegions must not contain blank region names',
      },
      {
        name: 'contains a duplicate name',
        targetRegions: ['us-east-1', 'us-east-1'],
        message: 'targetRegions must not contain duplicate region names',
      },
    ])('Should throw when targetRegions $name', ({ targetRegions, message }) => {
      const app = new App();
      expect(() => {
        new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
          ...baseProps,
          targetRegions,
        });
      }).toThrow(message);
    });
  });

  describe('resource wait', () => {
    it('Should set custom wait environment variables', () => {
      const app = new App();
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
        ...baseProps,
        resourceWait: {
          intervalSeconds: 30,
          maxSeconds: 600,
        },
        notification: {
          slack: {
            enable: SlackNotificationEnable.ENABLED,
            secretName: 'example/slack/webhook',
            notifyOnWaitTimeout: WaitTimeoutNotification.DISABLED,
          },
        },
      });
      const template = Template.fromStack(stack);

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            WAIT_INTERVAL_SECONDS: '30',
            MAX_WAIT_SECONDS: '600',
            NOTIFY_SLACK_ON_WAIT_TIMEOUT: 'false',
            SLACK_SECRET_NAME: 'example/slack/webhook',
          }),
        },
      });
    });

    it.each([
      {
        name: 'interval is not a positive integer',
        resourceWait: { intervalSeconds: 0, maxSeconds: 1800 },
        message: 'resourceWait.intervalSeconds must be a positive integer',
      },
      {
        name: 'max is not a positive integer',
        resourceWait: { intervalSeconds: 60, maxSeconds: 0 },
        message: 'resourceWait.maxSeconds must be a positive integer',
      },
      {
        name: 'max is below the interval',
        resourceWait: { intervalSeconds: 120, maxSeconds: 60 },
        message: 'resourceWait.maxSeconds must be greater than or equal to resourceWait.intervalSeconds',
      },
      {
        name: 'max exceeds the durable execution headroom',
        resourceWait: { intervalSeconds: 60, maxSeconds: 6901 },
        message: 'resourceWait.maxSeconds must be less than or equal to 6900',
      },
    ])('Should throw when $name', ({ resourceWait, message }) => {
      const app = new App();
      expect(() => {
        new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
          targetResource: baseProps.targetResource,
          resourceWait,
        });
      }).toThrow(message);
    });
  });

  describe('failure detection', () => {
    const alarmTopicArn = 'arn:aws:sns:ap-northeast-1:123456789012:alarm-topic';

    const synthesize = (failureDetection?: LambdaFailureDetection): Template => {
      const app = new App();
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
        ...baseProps,
        failureDetection,
      });
      return Template.fromStack(stack);
    };

    it.each([
      { name: 'is omitted', failureDetection: undefined },
      { name: 'is not enabled', failureDetection: {} },
      { name: 'is explicitly disabled', failureDetection: { enabled: false } },
    ])('Should create no alarms or metric filters when failure detection $name', ({ failureDetection }) => {
      const template = synthesize(failureDetection);

      template.resourceCountIs('AWS::CloudWatch::Alarm', 0);
      template.resourceCountIs('AWS::Logs::MetricFilter', 0);
      template.resourceCountIs('AWS::SNS::Topic', 0);
    });

    describe('enabled without an alarm topic', () => {
      const template = synthesize({ enabled: true });

      it('Should alarm on the Lambda Errors and Throttles metrics', () => {
        const [functionLogicalId] = Object.keys(template.findResources('AWS::Lambda::Function'));

        for (const metricName of ['Errors', 'Throttles']) {
          template.hasResourceProperties('AWS::CloudWatch::Alarm', {
            Namespace: 'AWS/Lambda',
            MetricName: metricName,
            Dimensions: [{ Name: 'FunctionName', Value: { Ref: functionLogicalId } }],
          });
        }
      });

      it.each([
        'ResourceWaitTimedOut',
        'ResourceStatusUnexpected',
        'ScheduleExecutionFailed',
      ])('Should filter the %s marker on the scheduler log group and alarm on its metric', (marker) => {
        const [logGroupLogicalId] = Object.keys(template.findResources('AWS::Logs::LogGroup'));

        template.hasResourceProperties('AWS::Logs::MetricFilter', {
          LogGroupName: { Ref: logGroupLogicalId },
          FilterPattern: `"${marker}"`,
          MetricTransformations: [
            Match.objectLike({
              MetricNamespace: 'RDSDatabaseRunningScheduler',
              MetricName: marker,
              MetricValue: '1',
            }),
          ],
        });
        template.hasResourceProperties('AWS::CloudWatch::Alarm', {
          Namespace: 'RDSDatabaseRunningScheduler',
          MetricName: marker,
        });
      });

      it('Should create only those alarms and filters, reusing the existing log group', () => {
        template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
        template.resourceCountIs('AWS::Logs::MetricFilter', 3);
        template.resourceCountIs('AWS::Logs::LogGroup', 1);
      });

      it('Should neither create an SNS topic nor attach alarm actions', () => {
        template.resourceCountIs('AWS::SNS::Topic', 0);
        template.allResourcesProperties('AWS::CloudWatch::Alarm', {
          AlarmActions: Match.absent(),
        });
      });

      it('Should keep the shared scheduler wiring', () => {
        expectSchedulerWiring(template, 'ENABLED');
      });
    });

    describe('enabled with an alarm topic', () => {
      const app = new App();
      const topicStack = new Stack(app, 'TopicStack');
      const alarmTopic = Topic.fromTopicArn(topicStack, 'AlarmTopic', alarmTopicArn);
      const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
        ...baseProps,
        failureDetection: { enabled: true, alarmTopic },
      });
      const template = Template.fromStack(stack);

      it('Should notify the given topic from every alarm without creating a topic', () => {
        template.resourceCountIs('AWS::SNS::Topic', 0);
        template.allResourcesProperties('AWS::CloudWatch::Alarm', {
          AlarmActions: [alarmTopicArn],
        });
      });

      it('Should match snapshot', () => {
        expect(template.toJSON()).toMatchSnapshot();
      });
    });
  });
});
