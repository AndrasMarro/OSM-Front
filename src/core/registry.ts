/**
 * Keyed catalogue of definitions. Content (buildings, units) is registered
 * here as plain data; the engine only ever looks definitions up by id.
 */
export class Registry<T extends { id: string }> {
  private readonly items = new Map<string, T>();

  register(def: T): T {
    if (this.items.has(def.id)) throw new Error(`"${def.id}" is already registered`);
    this.items.set(def.id, def);
    return def;
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  /** In registration order. */
  list(): T[] {
    return [...this.items.values()];
  }
}
