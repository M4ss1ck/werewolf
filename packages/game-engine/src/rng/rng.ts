export interface WeightedItem<T> {
  value: T;
  weight: number;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A deterministic stream whose child streams are independent by scope. */
export class SeededRng {
  private readonly seed: string;
  private state: number;

  constructor(seed: string | number) {
    this.seed = String(seed);
    this.state = hashSeed(this.seed);
  }

  derive(scope: string): SeededRng {
    return new SeededRng(`${this.seed}:${scope}`);
  }

  float(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error("maxExclusive must be a positive integer");
    }
    return Math.floor(this.float() * maxExclusive);
  }

  weightedPick<T>(items: readonly WeightedItem<T>[]): T {
    const totalWeight = items.reduce((total, item) => total + item.weight, 0);
    if (items.length === 0 || totalWeight <= 0 || !Number.isFinite(totalWeight)) {
      throw new Error("weightedPick requires positively weighted items");
    }

    let remaining = this.float() * totalWeight;
    for (const item of items) {
      if (item.weight > 0) {
        remaining -= item.weight;
        if (remaining < 0) return item.value;
      }
    }
    return items[items.length - 1]!.value;
  }
}

export function createRng(seed: string | number): SeededRng {
  return new SeededRng(seed);
}
