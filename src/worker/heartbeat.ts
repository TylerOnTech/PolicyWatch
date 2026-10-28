import type { Redis } from 'ioredis';

export interface WorkerHeartbeat {
  workerId: string;
  hostname: string;
  pid: number;
  startedAt: string;
  lastHeartbeatAt: string;
  loops: Array<{ name: string; lastSuccessAt: string | null; consecutiveErrors: number }>;
}

export const heartbeatKey = (prefix: string, workerId: string) => `${prefix}:workers:${workerId}`;

export async function writeHeartbeat(redis: Redis, prefix: string, hb: WorkerHeartbeat, ttlSeconds: number) {
  await redis.set(heartbeatKey(prefix, hb.workerId), JSON.stringify(hb), 'EX', ttlSeconds);
}

/** Live workers = heartbeat keys that have not expired. Used by the API's /health. */
export async function readHeartbeats(redis: Redis, prefix: string): Promise<WorkerHeartbeat[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${prefix}:workers:*`, 'COUNT', 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0' && keys.length < 1_000);
  if (keys.length === 0) return [];
  const values = await redis.mget(...keys);
  return values.flatMap((v) => {
    if (!v) return [];
    try {
      return [JSON.parse(v) as WorkerHeartbeat];
    } catch {
      return [];
    }
  });
}
