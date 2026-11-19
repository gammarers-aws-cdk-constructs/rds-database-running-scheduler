import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { LambdaFailureDetection } from 'lambda-failure-detector';
import { RDSDatabaseRunningScheduleStack } from '../src';
import { baseProps, expectSchedulerWiring } from './stack-helpers';

const alarmTopicArn = 'arn:aws:sns:ap-northeast-1:123456789012:alarm-topic';

const synthesize = (failureDetection?: LambdaFailureDetection): Template => {
  const app = new App();
  const stack = new RDSDatabaseRunningScheduleStack(app, 'RDSDatabaseRunningScheduleStack', {
    ...baseProps,
    failureDetection,
  });
  return Template.fromStack(stack);
};

describe('failure detection off', () => {
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
