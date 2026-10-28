/**
 * Runs the whole stack without Docker (API, worker, carrier simulator, mock receiver) with prefixed
 * output. Requires PostgreSQL and Redis reachable at DATABASE_URL / REDIS_URL.
 *
 *   npm run dev
 */
import { spawn, type ChildProcess } from 'node:child_process';

const services = [
  { name: 'carriers', color: 35, entry: 'src/entrypoints/carrier-sim.ts' },
  { name: 'receiver', color: 34, entry: 'src/entrypoints/mock-receiver.ts' },
  { name: 'api', color: 32, entry: 'src/entrypoints/api.ts' },
  { name: 'worker', color: 33, entry: 'src/entrypoints/worker.ts' },
];

const children: ChildProcess[] = [];
for (const s of services) {
  const child = spawn(process.execPath, ['--env-file-if-exists=.env', '--import', 'tsx', s.entry], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOG_PRETTY: process.env.LOG_PRETTY ?? 'true' },
  });
  const prefix = `\x1b[${s.color}m${s.name.padEnd(8)}\x1b[0m│ `;
  const pipe = (stream: NodeJS.ReadableStream) => {
    let buffer = '';
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) process.stdout.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on('exit', (code) => process.stdout.write(`${prefix}exited (${code})\n`));
  children.push(child);
}

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3_000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
