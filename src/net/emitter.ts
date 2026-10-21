export type Unsubscribe = () => void;

/** Minimal typed event emitter. Listener errors are caught so one bad listener can't break the session. */
export class Emitter<E extends { [K in keyof E]: (...args: any[]) => void }> {
  private map = new Map<keyof E, Set<E[keyof E]>>();

  on<K extends keyof E>(type: K, cb: E[K]): Unsubscribe {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(cb);
    return () => {
      set!.delete(cb);
    };
  }

  emit<K extends keyof E>(type: K, ...args: Parameters<E[K]>): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (...a: Parameters<E[K]>) => void)(...args);
      } catch (e) {
        console.error(`[net] listener for "${String(type)}" threw`, e);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }
}
