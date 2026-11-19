import { Match, Template } from 'aws-cdk-lib/assertions';
import { SlackNotificationEnable } from '../src';

export const baseProps = {
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
export const expectSchedulerWiring = (template: Template, state: 'ENABLED' | 'DISABLED'): void => {
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
