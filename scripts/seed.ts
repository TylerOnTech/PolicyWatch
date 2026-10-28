/**
 * Enrolls every synthetic policy known to the carrier simulator. Idempotent: re-running reports
 * already-enrolled policies instead of duplicating them. Baseline checks are queued for the worker.
 *
 *   npm run db:seed            (reads .env when run via the npm script)
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { closeDeps, createDeps } from '../src/deps.js';
import { enrollPolicy } from '../src/monitoring/enrollment.js';
import { seedPolicies } from '../src/simulators/carrier-sim/store.js';

async function main() {
  const config = loadConfig();
  const deps = createDeps(config, { service: 'policywatch-seed' });
  const correlationId = `seed-${randomUUID()}`;
  try {
    for (const p of seedPolicies()) {
      const { policy, created } = await enrollPolicy(
        deps,
        { carrierId: p.carrierId, externalPolicyId: p.policyNumber, checkIntervalSeconds: config.monitoring.defaultCheckIntervalSeconds },
        correlationId,
      );
      console.log(`${created ? 'enrolled ' : 'existing '} ${policy.id}  ${p.carrierId.padEnd(9)} ${p.policyNumber}`);
    }
    console.log('Baseline checks queued; the worker will retrieve version 1 of each policy.');
  } finally {
    await closeDeps(deps);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
