import {
  getPathFromEvents,
  getShortestPaths,
  getSimplePaths,
  getStateNodes,
  serializeState,
  StatePathsMap,
  TraversalOptions
} from '@xstate/graph';
import { StateMachine, EventObject, State, StateValue } from 'xstate';
import slimChalk from './slimChalk';
import {
  TestModelCoverage,
  TestModelOptions,
  TestPlan,
  StatePredicate,
  TestPathResult,
  TestStepResult,
  TestMeta,
  EventExecutor,
  CoverageOptions
} from './types';

/**
 * Creates a test model that represents an abstract model of a
 * system under test (SUT).
 *
 * The test model is used to generate test plans, which are used to
 * verify that states in the `machine` are reachable in the SUT.
 *
 * @example
 *
 * ```js
 * const toggleModel = createModel(toggleMachine).withEvents({
 *   TOGGLE: {
 *     exec: async page => {
 *       await page.click('input');
 *     }
 *   }
 * });
 * ```
 *
 */
export class TestModel<TTestContext, TContext> {
  public coverage: TestModelCoverage = {
    stateNodes: new Map(),
    transitions: new Map()
  };
  public options: TestModelOptions<TTestContext>;
  public static defaultOptions: TestModelOptions<any> = {
    events: {}
  };

  constructor(
    public machine: StateMachine<TContext, any, any>,
    options?: Partial<TestModelOptions<TTestContext>>
  ) {
    this.options = {
      ...TestModel.defaultOptions,
      ...options
    };
  }

  public getShortestPathPlans(
    options?: TraversalOptions<State<TContext, any>, any>
  ): Array<TestPlan<TTestContext, TContext>> {
    const shortestPaths = getShortestPaths(
      this.machine,
      getEventSamples<TTestContext>(this.options.events),
      {
        serializeState,
        ...options
      }
    );

    return this.getTestPlans(shortestPaths);
  }

  public getShortestPathPlansTo(
    stateValue: StateValue | StatePredicate<TContext>
  ): Array<TestPlan<TTestContext, TContext>> {
    let minWeight = Infinity;
    let shortestPlans: Array<TestPlan<TTestContext, TContext>> = [];

    const plans = this.filterPathsTo(stateValue, this.getShortestPathPlans());

    for (const plan of plans) {
      const currWeight = plan.paths[0].weight;
      if (currWeight < minWeight) {
        minWeight = currWeight;
        shortestPlans = [plan];
      } else if (currWeight === minWeight) {
        shortestPlans.push(plan);
      }
    }

    return shortestPlans;
  }

  private filterPathsTo(
    stateValue: StateValue | StatePredicate<TContext>,
    testPlans: Array<TestPlan<TTestContext, TContext>>
  ): Array<TestPlan<TTestContext, TContext>> {
    const predicate =
      typeof stateValue === 'function'
        ? (plan) => stateValue(plan.state)
        : (plan) => plan.state.matches(stateValue);
    return testPlans.filter(predicate);
  }

  public getPlanFromEvents(
    events: Array<EventObject>,
    { target }: { target: StateValue }
  ): TestPlan<TTestContext, TContext> {
    const path = getPathFromEvents<TContext>(this.machine, events);

    if (!path.state.matches(target)) {
      throw new Error(
        `The last state ${JSON.stringify(
          (path.state as any).value
        )} does not match the target: ${JSON.stringify(target)}`
      );
    }

    const plans = this.getTestPlans({
      [JSON.stringify(path.state.value)]: {
        state: path.state,
        paths: [path]
      }
    });

    return plans[0];
  }

  public getSimplePathPlans(
    options?: Partial<TraversalOptions<State<TContext, any>, any>>
  ): Array<TestPlan<TTestContext, TContext>> {
    const simplePaths = getSimplePaths(
      this.machine,
      getEventSamples(this.options.events),
      {
        serializeState,
        ...options
      }
    );

    return this.getTestPlans(simplePaths);
  }

  public getSimplePathPlansTo(
    stateValue: StateValue | StatePredicate<TContext>
  ): Array<TestPlan<TTestContext, TContext>> {
    return this.filterPathsTo(stateValue, this.getSimplePathPlans());
  }

  public getTestPlans(
    statePathsMap: StatePathsMap<State<TContext, any>, any>
  ): Array<TestPlan<TTestContext, TContext>> {
    return Object.keys(statePathsMap).map((key) => {
      const testPlan = statePathsMap[key];
      const paths = testPlan.paths.map((path) => {
        const steps = path.steps.map((step) => {
          return {
            ...step,
            description: getDescription(step.state),
            test: (testContext) => this.testState(step.state, testContext),
            exec: (testContext) => this.executeEvent(step.event, testContext)
          };
        });

        function formatEvent(event: EventObject): string {
          const { type, ...other } = event;

          const propertyString = Object.keys(other).length
            ? ` (${JSON.stringify(other)})`
            : '';

          return `${type}${propertyString}`;
        }

        const eventsString = path.steps
          .map((s) => formatEvent(s.event))
          .join(' → ');

        return {
          ...path,
          steps,
          description: `via ${eventsString}`,
          test: async (testContext) => {
            const testPathResult: TestPathResult = {
              steps: [],
              state: {
                error: null
              }
            };

            try {
              for (const step of steps) {
                const testStepResult: TestStepResult = {
                  step,
                  state: { error: null },
                  event: { error: null }
                };

                testPathResult.steps.push(testStepResult);

                try {
                  await step.test(testContext);
                } catch (err) {
                  testStepResult.state.error = err;

                  throw err;
                }

                try {
                  await step.exec(testContext);
                } catch (err) {
                  testStepResult.event.error = err;

                  throw err;
                }
              }

              try {
                await this.testState(testPlan.state, testContext);
              } catch (err) {
                testPathResult.state.error = err;
                throw err;
              }
            } catch (err) {
              const targetStateString = `${JSON.stringify(path.state.value)} ${
                path.state.context === undefined
                  ? ''
                  : JSON.stringify(path.state.context)
              }`;

              let hasFailed = false;
              err.message +=
                '\nPath:\n' +
                testPathResult.steps
                  .map((s) => {
                    const stateString = `${JSON.stringify(
                      s.step.state.value
                    )} ${
                      s.step.state.context === undefined
                        ? ''
                        : JSON.stringify(s.step.state.context)
                    }`;
                    const eventString = `${JSON.stringify(s.step.event)}`;

                    const stateResult = `\tState: ${
                      hasFailed
                        ? slimChalk('gray', stateString)
                        : s.state.error
                        ? ((hasFailed = true),
                          slimChalk('redBright', stateString))
                        : slimChalk('greenBright', stateString)
                    }`;
                    const eventResult = `\tEvent: ${
                      hasFailed
                        ? slimChalk('gray', eventString)
                        : s.event.error
                        ? ((hasFailed = true), slimChalk('red', eventString))
                        : slimChalk('green', eventString)
                    }`;

                    return [stateResult, eventResult].join('\n');
                  })
                  .concat(
                    `\tState: ${
                      hasFailed
                        ? slimChalk('gray', targetStateString)
                        : testPathResult.state.error
                        ? slimChalk('red', targetStateString)
                        : slimChalk('green', targetStateString)
                    }`
                  )
                  .join('\n\n');

              throw err;
            }

            return testPathResult;
          }
        };
      });

      return {
        ...testPlan,
        test: async (testContext) => {
          for (const path of paths) {
            await path.test(testContext);
          }
        },
        description: `reaches ${getDescription(testPlan.state)}`,
        paths
      } as TestPlan<TTestContext, TContext>;
    });
  }

  public async testState(
    state: State<TContext, any>,
    testContext: TTestContext
  ) {
    for (const id of Object.keys(state.meta)) {
      const stateNodeMeta = state.meta[id] as TestMeta<TTestContext, TContext>;
      if (typeof stateNodeMeta.test === 'function' && !stateNodeMeta.skip) {
        this.coverage.stateNodes.set(
          id,
          (this.coverage.stateNodes.get(id) || 0) + 1
        );

        await stateNodeMeta.test(testContext, state);
      }
    }
  }

  public getEventExecutor(
    event: EventObject
  ): EventExecutor<TTestContext> | undefined {
    const testEvent = this.options.events[event.type];

    if (!testEvent) {
      // tslint:disable-next-line:no-console
      console.warn(`Missing config for event "${event.type}".`);
      return undefined;
    }

    if (typeof testEvent === 'function') {
      return testEvent;
    }

    return testEvent.exec;
  }

  public async executeEvent(event: EventObject, testContext: TTestContext) {
    const executor = this.getEventExecutor(event);

    if (executor) {
      await executor(testContext, event);
    }
  }

  public getCoverage(
    options?: CoverageOptions<TContext>
  ): { stateNodes: Record<string, number> } {
    const filter = options ? options.filter : undefined;
    const stateNodes = getStateNodes(this.machine);
    const filteredStateNodes = filter ? stateNodes.filter(filter) : stateNodes;
    const coverage = {
      stateNodes: filteredStateNodes.reduce((acc, stateNode) => {
        acc[stateNode.id] = 0;
        return acc;
      }, {})
    };

    for (const key of this.coverage.stateNodes.keys()) {
      coverage.stateNodes[key] = this.coverage.stateNodes.get(key);
    }

    return coverage;
  }

  public testCoverage(options?: CoverageOptions<TContext>): void {
    const coverage = this.getCoverage(options);
    const missingStateNodes = Object.keys(coverage.stateNodes).filter((id) => {
      return !coverage.stateNodes[id];
    });

    if (missingStateNodes.length) {
      throw new Error(
        'Missing coverage for state nodes:\n' +
          missingStateNodes.map((id) => `\t${id}`).join('\n')
      );
    }
  }

  public withEvents(
    eventMap: TestModelOptions<TTestContext>['events']
  ): TestModel<TTestContext, TContext> {
    return new TestModel<TTestContext, TContext>(this.machine, {
      events: eventMap
    });
  }
}

function getDescription<T, TContext>(state: State<TContext, any>): string {
  const contextString =
    state.context === undefined ? '' : `(${JSON.stringify(state.context)})`;

  const stateStrings = state.configuration
    .filter((sn) => sn.type === 'atomic' || sn.type === 'final')
    .map(({ id }) => {
      const meta = state.meta[id] as TestMeta<T, TContext>;
      if (!meta) {
        return `"#${id}"`;
      }

      const { description } = meta;

      if (typeof description === 'function') {
        return description(state);
      }

      return description ? `"${description}"` : JSON.stringify(state.value);
    });

  return (
    `state${stateStrings.length === 1 ? '' : 's'}: ` +
    stateStrings.join(', ') +
    ` ${contextString}`
  );
}

export function getEventSamples<T>(
  eventsOptions: TestModelOptions<T>['events']
) {
  const result: T[] = [];

  Object.keys(eventsOptions).forEach((key) => {
    const eventConfig = eventsOptions[key];
    if (typeof eventConfig === 'function') {
      result.push({
        type: key
      } as any);
      return;
    }

    const events = eventConfig.cases
      ? eventConfig.cases.map((sample) => ({
          type: key,
          ...sample
        }))
      : [
          {
            type: key
          }
        ];

    result.push(...(events as any[]));
  });

  return result;
}

/**
 * Creates a test model that represents an abstract model of a
 * system under test (SUT).
 *
 * The test model is used to generate test plans, which are used to
 * verify that states in the `machine` are reachable in the SUT.
 *
 * @example
 *
 * ```js
 * const toggleModel = createModel(toggleMachine).withEvents({
 *   TOGGLE: {
 *     exec: async page => {
 *       await page.click('input');
 *     }
 *   }
 * });
 * ```
 *
 * @param machine The state machine used to represent the abstract model.
 * @param options Options for the created test model:
 * - `events`: an object mapping string event types (e.g., `SUBMIT`)
 * to an event test config (e.g., `{exec: () => {...}, cases: [...]}`)
 */
export function createModel<TestContext, TContext = any>(
  machine: StateMachine<TContext, any, any>,
  options?: TestModelOptions<TestContext>
): TestModel<TestContext, TContext> {
  return new TestModel<TestContext, TContext>(machine, options);
}
