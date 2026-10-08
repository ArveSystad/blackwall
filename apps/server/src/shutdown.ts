export type ShutdownHook = () => void | Promise<void>;

export interface Shutdown {
  /** Registers a hook; hooks run in reverse registration order. Returns an unregister function. */
  onShutdown(hook: ShutdownHook): () => void;
  /** Runs all hooks once; later calls return the same promise. */
  run(): Promise<void>;
}

export function createShutdown(log: (message: string) => void = console.error): Shutdown {
  const hooks = new Set<ShutdownHook>();
  let running: Promise<void> | undefined;

  return {
    onShutdown(hook) {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },
    run() {
      running ??= (async () => {
        for (const hook of [...hooks].reverse()) {
          try {
            await hook();
          } catch (error) {
            log(`Shutdown hook failed: ${String(error)}`);
          }
        }
        hooks.clear();
      })();
      return running;
    },
  };
}
