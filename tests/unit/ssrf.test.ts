import type dns from 'node:dns';
import { describe, expect, it } from 'vitest';
import { BlockedDestinationError, DestinationPolicy, isBlockedAddress } from '../../src/webhooks/ssrf.js';

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // AWS/GCP/Azure instance metadata
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fd00:ec2::254', // AWS IMDS over IPv6
    'fc00::1',
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe', // same, hex form
    '64:ff9b::10.0.0.1', // NAT64 to a private address
    'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('DestinationPolicy.validateUrl', () => {
  const policy = new DestinationPolicy({ requireHttps: true, allowedHosts: [] });

  it.each([
    ['ftp://example.com/hook', /scheme/],
    ['http://example.com/hook', /https/],
    ['https://user:pass@example.com/hook', /credentials/],
    ['https://example.com:22/hook', /port 22/],
    ['https://localhost/hook', /not permitted/],
    ['https://api.localhost/hook', /not permitted/],
    ['https://metadata.google.internal/computeMetadata/v1', /not permitted/],
    ['https://redis/hook', /fully-qualified/], // Docker service name
    ['https://169.254.169.254/latest/meta-data/', /private or reserved/],
    ['https://[::1]/hook', /private or reserved/],
    ['https://[::ffff:169.254.169.254]/hook', /private or reserved/],
    ['https://2130706433/hook', /private or reserved/], // decimal 127.0.0.1
    ['https://0x7f.1/hook', /private or reserved/], // hex/short-form 127.0.0.1
    ['https://127.1/hook', /private or reserved/],
    ['https://10.1.2.3/hook', /private or reserved/],
    ['not a url', /not valid/],
  ])('rejects %s', (url, reason) => {
    const result = policy.validateUrl(url);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(reason);
  });

  it('accepts a public https URL', () => {
    expect(policy.validateUrl('https://hooks.example.com/policywatch?team=retention').ok).toBe(true);
  });

  it('allowlisted development hosts bypass address checks (and the https requirement)', () => {
    const dev = new DestinationPolicy({ requireHttps: true, allowedHosts: ['mock-receiver', '127.0.0.1'] });
    expect(dev.validateUrl('http://mock-receiver:4100/webhooks').ok).toBe(true);
    expect(dev.validateUrl('http://127.0.0.1:4100/webhooks').ok).toBe(true);
    expect(dev.validateUrl('http://10.0.0.1/webhooks').ok).toBe(false);
  });
});

describe('DestinationPolicy DNS checks', () => {
  const resolvingTo = (address: string) =>
    new DestinationPolicy({
      requireHttps: true,
      allowedHosts: [],
      resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
    });

  it('rejects a public-looking hostname that resolves to a private address', async () => {
    const result = await resolvingTo('10.0.0.8').validateResolvedUrl('https://innocent.example.com/hook');
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/private or reserved/) });
  });

  it('rejects hostnames that do not resolve', async () => {
    const policy = new DestinationPolicy({
      requireHttps: true,
      allowedHosts: [],
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await policy.validateResolvedUrl('https://nope.example.com/hook')).toMatchObject({ ok: false });
  });

  it('accepts a hostname that resolves publicly', async () => {
    expect((await resolvingTo('93.184.216.34').validateResolvedUrl('https://hooks.example.com/x')).ok).toBe(true);
  });

  it('connect-time lookup refuses a rebinding answer even after the URL was validated', async () => {
    // First answer public (validation), then private (connection) — the classic DNS rebinding attack.
    const answers = ['93.184.216.34', '169.254.169.254'];
    const fakeLookup = ((_host: string, _opts: unknown, cb: (e: Error | null, a: dns.LookupAddress[]) => void) =>
      cb(null, [{ address: answers.shift()!, family: 4 }])) as unknown as typeof dns.lookup;
    const policy = new DestinationPolicy({
      requireHttps: true,
      allowedHosts: [],
      resolve: async () => [{ address: '93.184.216.34', family: 4 }],
      lookup: fakeLookup,
    });
    expect((await policy.validateResolvedUrl('https://rebind.example.com/x')).ok).toBe(true);
    answers.shift(); // the validation above used `resolve`; consume the "public" answer
    const err = await new Promise<Error | null>((resolve) =>
      policy.guardedLookup('rebind.example.com', { all: true }, (e) => resolve(e)),
    );
    expect(err).toBeInstanceOf(BlockedDestinationError);
  });
});
