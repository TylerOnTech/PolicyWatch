import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { currentCorrelationId } from './context.js';

export type { Logger };

/**
 * Paths censored in every log line. Policyholder details are never logged deliberately, but redaction
 * is a second line of defense in case an object containing them is passed to the logger.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'secret',
  '*.secret',
  'secretCiphertext',
  '*.secretCiphertext',
  'policyholder',
  '*.policyholder',
  '*.*.policyholder',
  'drivers',
  '*.drivers',
  '*.*.drivers',
  'email',
  '*.email',
  'phone',
  '*.phone',
  'dateOfBirth',
  '*.dateOfBirth',
  'password',
  '*.password',
];

export function createLogger(opts: {
  level: string;
  pretty?: boolean;
  service: string;
  version?: string;
  destination?: DestinationStream;
}): Logger {
  const options: LoggerOptions = {
    level: opts.level,
    base: { service: opts.service, version: opts.version },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label, number) => ({ level: number, severity: label }),
    },
    mixin() {
      const correlationId = currentCorrelationId();
      return correlationId ? { correlationId } : {};
    },
  };
  if (opts.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { singleLine: true } } });
  }
  return opts.destination ? pino(options, opts.destination) : pino(options);
}

export const silentLogger: Logger = pino({ level: 'silent' });
