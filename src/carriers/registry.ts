import type { CarrierEndpointConfig } from '../config.js';
import { createAcmeAdapter } from './adapters/acme.js';
import { createBluebirdAdapter } from './adapters/bluebird.js';
import { createCardinalAdapter } from './adapters/cardinal.js';
import type { CarrierAdapter } from './types.js';

export class CarrierRegistry {
  private readonly adapters: Map<string, CarrierAdapter>;

  constructor(adapters: CarrierAdapter[]) {
    this.adapters = new Map(adapters.map((a) => [a.carrierId, a]));
  }

  get(carrierId: string): CarrierAdapter | undefined {
    return this.adapters.get(carrierId);
  }

  has(carrierId: string): boolean {
    return this.adapters.has(carrierId);
  }

  list(): Array<{ carrierId: string; displayName: string }> {
    return [...this.adapters.values()].map((a) => ({ carrierId: a.carrierId, displayName: a.displayName }));
  }
}

/** Adding a carrier = writing one adapter module and registering it here. */
export function createCarrierRegistry(cfg: CarrierEndpointConfig): CarrierRegistry {
  const common = { timeoutMs: cfg.timeoutMs, maxResponseBytes: cfg.maxResponseBytes };
  return new CarrierRegistry([
    createAcmeAdapter({ ...cfg.acme, ...common }),
    createBluebirdAdapter({ ...cfg.bluebird, ...common }),
    createCardinalAdapter({ ...cfg.cardinal, ...common }),
  ]);
}
