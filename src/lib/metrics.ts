import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export interface Metrics {
  registry: Registry;
  httpRequests: Counter<'method' | 'route' | 'status'>;
  httpDuration: Histogram<'method' | 'route'>;
  policyChecks: Counter<'carrier' | 'outcome' | 'failure_category'>;
  policyCheckDuration: Histogram<'carrier'>;
  eventsGenerated: Counter<'event_type'>;
  outboxRelayed: Counter<'result'>;
  deliveryAttempts: Counter<'outcome'>;
  deliveryDuration: Histogram<'outcome'>;
  deliveriesFinalized: Counter<'status'>;
  sweeperRecovered: Counter<'kind'>;
  queueDepth: Gauge<'queue' | 'state'>;
  outboxPending: Gauge;
  loopErrors: Counter<'loop'>;
}

/** A fresh registry per process (and per test) avoids global-registry collisions. */
export function createMetrics(opts: { defaultMetrics?: boolean } = {}): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ app: 'policywatch' });
  if (opts.defaultMetrics) collectDefaultMetrics({ register: registry });
  const registers = [registry];

  return {
    registry,
    httpRequests: new Counter({
      name: 'policywatch_http_requests_total',
      help: 'HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status'],
      registers,
    }),
    httpDuration: new Histogram({
      name: 'policywatch_http_request_duration_seconds',
      help: 'API request latency',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers,
    }),
    policyChecks: new Counter({
      name: 'policywatch_policy_checks_total',
      help: 'Policy monitoring checks by outcome',
      labelNames: ['carrier', 'outcome', 'failure_category'],
      registers,
    }),
    policyCheckDuration: new Histogram({
      name: 'policywatch_policy_check_duration_seconds',
      help: 'End-to-end duration of a policy check (carrier call + persistence)',
      labelNames: ['carrier'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers,
    }),
    eventsGenerated: new Counter({
      name: 'policywatch_events_generated_total',
      help: 'Domain events committed',
      labelNames: ['event_type'],
      registers,
    }),
    outboxRelayed: new Counter({
      name: 'policywatch_outbox_messages_relayed_total',
      help: 'Outbox messages processed by the relay',
      labelNames: ['result'],
      registers,
    }),
    deliveryAttempts: new Counter({
      name: 'policywatch_webhook_attempts_total',
      help: 'Webhook HTTP attempts by outcome',
      labelNames: ['outcome'],
      registers,
    }),
    deliveryDuration: new Histogram({
      name: 'policywatch_webhook_attempt_duration_seconds',
      help: 'Webhook attempt latency',
      labelNames: ['outcome'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    }),
    deliveriesFinalized: new Counter({
      name: 'policywatch_webhook_deliveries_finalized_total',
      help: 'Deliveries reaching a terminal state',
      labelNames: ['status'],
      registers,
    }),
    sweeperRecovered: new Counter({
      name: 'policywatch_sweeper_recovered_total',
      help: 'Stuck deliveries re-enqueued by the recovery sweeper',
      labelNames: ['kind'],
      registers,
    }),
    queueDepth: new Gauge({
      name: 'policywatch_queue_jobs',
      help: 'BullMQ job counts by queue and state',
      labelNames: ['queue', 'state'],
      registers,
    }),
    outboxPending: new Gauge({
      name: 'policywatch_outbox_pending',
      help: 'Outbox messages awaiting relay',
      registers,
    }),
    loopErrors: new Counter({
      name: 'policywatch_background_loop_errors_total',
      help: 'Errors thrown by background loops (scheduler, relay, sweeper)',
      labelNames: ['loop'],
      registers,
    }),
  };
}
