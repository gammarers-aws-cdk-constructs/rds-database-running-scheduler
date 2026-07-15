import { App, TimeZone } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { RDSDatabaseRunningScheduleStack } from '../src';

const baseProps = {
  targetResource: {
    tagKey: 'WorkHoursRunning',
    tagValues: ['YES'],
  },
  notification: {
    slack: {
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
          }),
        },
      });
    });

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
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

    it('Should match snapshot', () => {
      expect(template.toJSON()).toMatchSnapshot();
    });
  });

  describe('disabled scheduling', () => {
    const app = new App();
    const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
      ...baseProps,
      enableScheduling: false,
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
      enableScheduling: true,
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
});
