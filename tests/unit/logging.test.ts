import { describe, expect, it } from 'vitest';
import { runWithContext } from '../../src/lib/context.js';
import { createLogger } from '../../src/lib/logger.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ level: 'info', service: 'test', destination: { write: (s: string) => lines.push(s) } });
  return { logger, lines, json: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe('structured logging', () => {
  it('emits one JSON object per line with level, severity, time and service', () => {
    const { logger, json } = capture();
    logger.info({ policyId: 'pol_x' }, 'hello');
    expect(json()[0]).toMatchObject({ level: 30, severity: 'info', service: 'test', policyId: 'pol_x', msg: 'hello' });
    expect(typeof json()[0]!.time).toBe('string');
  });

  it('redacts policyholder PII, driver data, secrets and credentials wherever they are logged', () => {
    const { logger, lines } = capture();
    logger.info(
      {
        req: { headers: { authorization: 'Bearer pw_live_key_123', cookie: 'session=abc' } },
        secret: 'whsec_plaintext',
        policy: {
          policyholder: { firstName: 'Jordan', email: 'jordan.rivera@example.com' },
          drivers: [{ dateOfBirth: '1990-05-17' }],
        },
        subscription: { secretCiphertext: 'v1.iv.tag.ct' },
        insured: { email: 'samir.patel@example.net', phone: '+15550104477' },
      },
      'payload with sensitive fields',
    );
    const out = lines.join('\n');
    for (const leaked of ['pw_live_key_123', 'session=abc', 'whsec_plaintext', 'Jordan', 'jordan.rivera', '1990-05-17', 'v1.iv.tag.ct', 'samir.patel', '+15550104477']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[REDACTED]');
  });

  it('stamps the ambient correlation ID on every line written inside a request/job context', () => {
    const { logger, json } = capture();
    runWithContext({ correlationId: 'req-abc-123' }, () => logger.child({ component: 'x' }).warn('inside'));
    logger.info('outside');
    expect(json()[0]).toMatchObject({ correlationId: 'req-abc-123', component: 'x', msg: 'inside' });
    expect(json()[1]!.correlationId).toBeUndefined();
  });
});
