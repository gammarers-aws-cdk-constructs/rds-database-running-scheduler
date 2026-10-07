import { App, TimeZone } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
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

describe('RDSDatabaseRunningScheduleStack', () => {
  describe('default schedule with Slack', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', baseProps);
    const template = Template.fromStack(stack);

    it('Should have 2 Schedules', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    });

    it('Should have Schedule with ENABLED and Lambda target', () => {
      template.allResourcesProperties('AWS::Scheduler::Schedule', {
        State: 'ENABLED',
        FlexibleTimeWindow: {
          Mode: 'OFF',
        },
        Target: {
          Arn: Match.anyValue(),
          RoleArn: Match.anyValue(),
          Input: Match.anyValue(),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185,
          },
        },
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

    it('Should have 2 Schedules', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    });

    it('Should have all Schedules DISABLED', () => {
      template.allResourcesProperties('AWS::Scheduler::Schedule', {
        State: 'DISABLED',
        FlexibleTimeWindow: {
          Mode: 'OFF',
        },
        Target: {
          Arn: Match.anyValue(),
          RoleArn: Match.anyValue(),
          Input: Match.anyValue(),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185,
          },
        },
      });
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

    it('Should have 2 Schedules', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    });

    it('Should have Schedule with ENABLED and Input', () => {
      template.allResourcesProperties('AWS::Scheduler::Schedule', {
        State: 'ENABLED',
        FlexibleTimeWindow: {
          Mode: 'OFF',
        },
        Target: {
          Arn: Match.anyValue(),
          RoleArn: Match.anyValue(),
          Input: Match.anyValue(),
          RetryPolicy: {
            MaximumEventAgeInSeconds: 86400,
            MaximumRetryAttempts: 185,
          },
        },
      });
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
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
});
