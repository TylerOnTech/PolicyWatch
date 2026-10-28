import dns from 'node:dns';
import net, { type LookupFunction } from 'node:net';

/**
 * SSRF protection for subscriber-supplied webhook URLs. Two layers:
 *
 * 1. `validateUrl` / `validateResolvedUrl` at subscription time: scheme, credentials, port, hostname
 *    and resolved-address checks, so obviously internal targets are rejected with a clear 400.
 * 2. `guardedLookup` at connect time: every DNS answer is re-checked inside the socket's own lookup,
 *    so the address that is validated is the address that is connected to. This closes the DNS
 *    rebinding gap between "validated at creation" and "resolved at delivery".
 *
 * Redirects are never followed by the sender, so a public URL cannot bounce to an internal one.
 */

const blockList = new net.BlockList();

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918 (Docker bridge networks live here)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];

const BLOCKED_V6: Array<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local (incl. AWS IMDS fd00:ec2::254)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
];

for (const [addr, prefix] of BLOCKED_V4) blockList.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of BLOCKED_V6) blockList.addSubnet(addr, prefix, 'ipv6');

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'kubernetes.default']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.svc', '.cluster.local'];

/** Expands an IPv6 literal into eight 16-bit groups. Returns null if it is not valid IPv6. */
function ipv6Groups(address: string): number[] | null {
  if (net.isIPv6(address) === false) return null;
  let addr = address.split('%')[0]!; // drop zone index
  // Embedded dotted-quad tail (e.g. ::ffff:127.0.0.1)
  const v4Tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4Tail) {
    const parts = v4Tail[1]!.split('.').map(Number);
    addr = addr.slice(0, -v4Tail[1]!.length) + `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...(addr.includes('::') ? Array(missing).fill('0') : []), ...tailGroups];
  return groups.length === 8 ? groups.map((g) => parseInt(g || '0', 16)) : null;
}

/** IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible or NAT64 IPv6 address. */
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [number, number, number, number, number, number, number, number];
  const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  const mapped = zeroPrefix && (g5 === 0xffff || g5 === 0);
  const nat64 = g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0;
  if (!mapped && !nat64) return null;
  return [g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff].join('.');
}

export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return blockList.check(address, 'ipv4');
  if (family === 6) {
    const groups = ipv6Groups(address);
    if (!groups) return true;
    const v4 = embeddedIpv4(groups);
    if (v4 !== null) return blockList.check(v4, 'ipv4') || v4 === '0.0.0.0' || groups.slice(0, 6).every((g) => g === 0);
    return blockList.check(address, 'ipv6');
  }
  return true; // not an IP at all: fail closed
}

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

export interface DestinationPolicyOptions {
  requireHttps: boolean;
  /** Exact hostnames exempt from address checks — for local development receivers only. */
  allowedHosts: string[];
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  lookup?: typeof dns.lookup;
}

export class DestinationPolicy {
  private readonly allowed: Set<string>;
  private readonly resolve: NonNullable<DestinationPolicyOptions['resolve']>;
  private readonly baseLookup: typeof dns.lookup;

  constructor(private readonly opts: DestinationPolicyOptions) {
    this.allowed = new Set(opts.allowedHosts.map((h) => h.toLowerCase()));
    this.resolve = opts.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
    this.baseLookup = opts.lookup ?? dns.lookup;
  }

  isAllowlisted(hostname: string): boolean {
    return this.allowed.has(stripBrackets(hostname).toLowerCase());
  }

  /** Static checks — no network access. */
  validateUrl(raw: string): UrlValidation {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'URL is not valid' };
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'URL scheme must be https' };
    if (url.username || url.password) return { ok: false, reason: 'URL must not contain credentials' };
    if (url.hash) return { ok: false, reason: 'URL must not contain a fragment' };

    // WHATWG URL parsing canonicalizes host spellings such as 2130706433, 0x7f.1 or 127.1 to 127.0.0.1.
    const host = stripBrackets(url.hostname).toLowerCase();
    const allowlisted = this.allowed.has(host);

    if (url.protocol === 'http:' && this.opts.requireHttps && !allowlisted) {
      return { ok: false, reason: 'URL scheme must be https' };
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443 && port < 1024) return { ok: false, reason: `port ${port} is not permitted` };

    if (allowlisted) return { ok: true, url };

    if (net.isIP(host)) {
      return isBlockedAddress(host) ? { ok: false, reason: 'URL resolves to a private or reserved address' } : { ok: true, url };
    }
    if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
      return { ok: false, reason: 'URL host is not permitted' };
    }
    if (!host.includes('.')) return { ok: false, reason: 'URL host must be a fully-qualified domain name' };
    return { ok: true, url };
  }

  /** Static checks plus DNS resolution. Used when a subscription is created or its URL changes. */
  async validateResolvedUrl(raw: string): Promise<UrlValidation> {
    const result = this.validateUrl(raw);
    if (!result.ok) return result;
    const host = stripBrackets(result.url.hostname);
    if (this.isAllowlisted(host) || net.isIP(host)) return result;
    let addresses: Array<{ address: string }>;
    try {
      addresses = await this.resolve(host);
    } catch {
      return { ok: false, reason: 'URL host could not be resolved' };
    }
    if (addresses.length === 0) return { ok: false, reason: 'URL host could not be resolved' };
    if (addresses.some((a) => isBlockedAddress(a.address))) {
      return { ok: false, reason: 'URL resolves to a private or reserved address' };
    }
    return result;
  }

  /** Connect-time DNS lookup that refuses to hand a blocked address to the socket. */
  readonly guardedLookup: LookupFunction = (hostname, options, callback) => {
    this.baseLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as dns.LookupAddress[];
      if (!this.isAllowlisted(hostname)) {
        const blocked = list.find((a) => isBlockedAddress(a.address));
        if (blocked || list.length === 0) {
          return callback(new BlockedDestinationError(hostname), '', 0);
        }
      }
      if (options.all) return callback(null, list);
      const first = list[0]!;
      return callback(null, first.address, first.family);
    });
  };
}

export class BlockedDestinationError extends Error {
  readonly code = 'ERR_BLOCKED_DESTINATION';
  constructor(hostname: string) {
    super(`Destination ${hostname} resolves to a private or reserved address`);
    this.name = 'BlockedDestinationError';
  }
}

const stripBrackets = (h: string) => (h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h);
