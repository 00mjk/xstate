import {
  EventObject,
  AssignAction,
  SCXML,
  AssignMeta,
  ActionObject,
  InvokeActionObject,
  ActionTypes,
  Spawnable,
  ActorRef,
  ActorRefFrom
} from './types';
import { SpawnedActorRef, State } from '.';
import { ObservableActorRef } from './ObservableActorRef';
import { isFunction, keys } from './utils';
import { createBehaviorFrom, Behavior } from './behavior';
import { registry } from './registry';

export function updateContext<TContext, TEvent extends EventObject>(
  context: TContext,
  _event: SCXML.Event<TEvent>,
  assignActions: Array<AssignAction<TContext, TEvent>>,
  state?: State<TContext, TEvent>,
  service?: ActorRef<TEvent>
): [TContext, Array<ActionObject<TContext, TEvent>>] {
  const capturedActions: InvokeActionObject[] = [];

  if (!context) {
    throw new Error(
      'Cannot assign to undefined `context`. Ensure that `context` is defined in the machine config.'
    );
  }

  const updatedContext = context
    ? assignActions.reduce((acc, assignAction) => {
        const { assignment } = assignAction as AssignAction<TContext, TEvent>;

        const spawner = <T extends Behavior<any, any>>(
          behavior: T,
          name: string
        ): T extends Behavior<infer TE, infer TEmitted>
          ? SpawnedActorRef<TE, TEmitted>
          : never => {
          const actorRef = new ObservableActorRef(behavior, name);

          capturedActions.push({
            type: ActionTypes.Invoke,
            src: actorRef,
            id: name
          });

          return actorRef as any; // TODO: fix
        };

        spawner.from = <T extends Spawnable>(
          entity: T,
          name: string = registry.bookId() // TODO: use more universal uniqueid
        ): ActorRefFrom<T> => {
          const behavior = createBehaviorFrom(entity as any, service); // TODO: fix

          return (spawner(behavior, name) as unknown) as ActorRefFrom<T>; // TODO: fix
        };

        const meta: AssignMeta<TContext, TEvent> = {
          state,
          action: assignAction,
          _event,
          self: service,
          spawn: spawner
        };

        let partialUpdate: Partial<TContext> = {};
        if (isFunction(assignment)) {
          partialUpdate = assignment(acc, _event.data, meta);
        } else {
          for (const key of keys(assignment)) {
            const propAssignment = assignment[key];
            partialUpdate[key] = isFunction(propAssignment)
              ? propAssignment(acc, _event.data, meta)
              : propAssignment;
          }
        }
        return Object.assign({}, acc, partialUpdate);
      }, context)
    : context;

  return [updatedContext, capturedActions];
}
