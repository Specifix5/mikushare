// Tiny collection-method shims for browsers predating PDF.js 6's baseline.
for (const collection of [Map, WeakMap]) {
  if (!collection.prototype.getOrInsertComputed) {
    Object.defineProperty(collection.prototype, 'getOrInsertComputed', {
      configurable: true,
      writable: true,
      value(key, callback) {
        if (this.has(key)) return this.get(key);
        const result = callback(key);
        this.set(key, result);
        return result;
      },
    });
  }
  if (!collection.prototype.getOrInsert) {
    Object.defineProperty(collection.prototype, 'getOrInsert', {
      configurable: true,
      writable: true,
      value(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
    });
  }
}
