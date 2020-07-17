import { Interpreter, AnyEventObject } from 'xstate';

export type ServiceListener = (service: Interpreter<any>) => void;

type MaybeLazy<T> = T | (() => T);

export interface InspectorOptions {
  url: string;
  iframe: MaybeLazy<HTMLIFrameElement | null | false>;
}

declare global {
  interface Window {
    __xstate__: {
      register: (service: Interpreter<any>) => void;
      onRegister: (
        listener: ServiceListener
      ) => {
        unsubscribe: () => void;
      };
      services: Set<Interpreter<any>>;
    };
  }
}

const services = new Set<Interpreter<any>>();
const serviceListeners = new Set<ServiceListener>();

window.__xstate__ = {
  services,
  register: (service) => {
    services.add(service);
    serviceListeners.forEach((listener) => listener(service));
  },
  onRegister: (listener) => {
    serviceListeners.add(listener);
    services.forEach((service) => listener(service));

    return {
      unsubscribe: () => {
        serviceListeners.delete(listener);
      }
    };
  }
};

const defaultInspectorOptions: InspectorOptions = {
  url: 'https://embed.statecharts.io',
  iframe: () => document.querySelector<HTMLIFrameElement>('iframe[data-xstate]')
};

export function inspect(options?: Partial<InspectorOptions>) {
  const { iframe, url } = { ...defaultInspectorOptions, ...options };
  const resolvedIframe = typeof iframe === 'function' ? iframe() : iframe;
  const deferredEvents: AnyEventObject[] = [];
  let targetWindow: Window | null | undefined;
  let isDeferred = true;

  const postMessage = (event: AnyEventObject) => {
    if (isDeferred) {
      deferredEvents.push(event);
    } else {
      targetWindow!.postMessage(event, '*');
    }
  };

  if (resolvedIframe === null) {
    console.warn(
      'No suitable <iframe> found to embed the inspector. Please pass an <iframe> element to `inspect(iframe)` or create an <iframe data-xstate></iframe> element.'
    );

    return;
  }

  window.addEventListener('message', (event) => {
    if (
      typeof event.data === 'object' &&
      event.data !== null &&
      'type' in event.data &&
      event.data.type === 'xstate.inspecting'
    ) {
      isDeferred = false;
      // TODO: use a state machine...
      setTimeout(() => {
        while (deferredEvents.length > 0) {
          targetWindow!.postMessage(deferredEvents.shift()!, url);
        }
      }, 1000);
    }
  });

  if (resolvedIframe === false) {
    targetWindow = window.open(url, 'xstateinspector');
  }

  window.__xstate__.onRegister((service) => {
    postMessage({
      type: 'service.register',
      machine: JSON.stringify(service.machine),
      state: JSON.stringify(service.state || service.initialState),
      id: service.id
    });

    service.subscribe((state) => {
      postMessage({
        type: 'service.state',
        state: JSON.stringify(state),
        id: service.id
      });
    });
  });

  if (resolvedIframe) {
    resolvedIframe.addEventListener('load', () => {
      targetWindow = resolvedIframe.contentWindow!;
    });

    resolvedIframe.setAttribute('src', url);
  }
}
