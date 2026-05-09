// Tiny in-house reactive signals: signal/computed/effect. Used by the
// custom-element components to subscribe to derived state and re-render
// on change. Effects return a dispose function the caller (typically
// disconnectedCallback) must invoke to release listeners.

export type Signal<T> = {
  (): T;
  set(value: T): void;
  update(mutator: (current: T) => T): void;
  peek(): T;
};

export type ReadonlySignal<T> = (() => T) & { peek(): T };

interface ActiveScope {
  add(producer: SubscriberSet): void;
}

type SubscriberSet = Set<ActiveScope>;

let activeScope: ActiveScope | null = null;

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers: SubscriberSet = new Set();

  const accessor = (() => {
    if (activeScope) {
      activeScope.add(subscribers);
      subscribers.add(activeScope);
    }
    return value;
  }) as Signal<T>;

  accessor.set = (next: T) => {
    if (Object.is(next, value)) {
      return;
    }
    value = next;
    // Clone so handlers can resubscribe without confusing the iteration.
    for (const subscriber of [...subscribers]) {
      subscriber.add(subscribers); // no-op for retained scopes; keeps shape consistent
      runScope(subscriber);
    }
  };
  accessor.update = (mutator: (current: T) => T) => {
    accessor.set(mutator(value));
  };
  accessor.peek = () => value;

  return accessor;
}

function runScope(scope: ActiveScope): void {
  const runnable = scope as unknown as { __run?: () => void };
  if (typeof runnable.__run === "function") {
    runnable.__run();
  }
}

export function computed<T>(compute: () => T): ReadonlySignal<T> {
  let memo: T;
  let initialized = false;
  const internal = signal<unknown>(Symbol("uninitialized"));

  effect(() => {
    const next = compute();
    if (!initialized) {
      initialized = true;
      memo = next;
      internal.set(memo);
      return;
    }
    if (!Object.is(next, memo)) {
      memo = next;
      internal.set(memo);
    }
  });

  const accessor = (() => {
    internal();
    return memo;
  }) as ReadonlySignal<T>;
  accessor.peek = () => memo;
  return accessor;
}

export function effect(run: () => void): () => void {
  let stopped = false;
  const producers: SubscriberSet[] = [];

  const scope: ActiveScope & { __run?: () => void } = {
    add(producer: SubscriberSet) {
      if (!producers.includes(producer)) {
        producers.push(producer);
      }
    }
  };

  function cleanupSubscriptions(): void {
    for (const producer of producers) {
      producer.delete(scope);
    }
    producers.length = 0;
  }

  function execute(): void {
    if (stopped) {
      return;
    }
    cleanupSubscriptions();
    const previous = activeScope;
    activeScope = scope;
    try {
      run();
    } finally {
      activeScope = previous;
    }
  }

  scope.__run = execute;
  execute();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    cleanupSubscriptions();
  };
}
