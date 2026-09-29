import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF protection: decides whether the platform may open a connection to a host.
 *
 * Checks happen in two places:
 * 1. `assertAllowedUrl` before a request (protocol, hostname rules, IP literals).
 * 2. `createGuardedLookup` inside the socket's DNS lookup, so every address the connection
 *    actually dials is checked. Resolving once to validate and again to connect would let a
 *    DNS answer change in between (DNS rebinding); checking at connect time closes that gap.
 */

export class BlockedTargetError extends Error {
  readonly code = 'BLOCKED_TARGET';
  constructor(message: string) {
    super(message);
    this.name = 'BlockedTargetError';
  }
}

export interface SsrfOptions {
  /**
   * Allow private, loopback and link-local targets. For local development against APIs on
   * the same machine only; never enable in production.
   */
  allowPrivateNetwork?: boolean;
}

// ─── Address ranges ──────────────────────────────────────────────────────────

const blocked = new BlockList();
// IPv4 (RFC 6890 special-purpose and private ranges)
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
// IPv6
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local, incl. AWS IMDS fd00:ec2::254
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** IPv4 embedded in IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses. */
function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1]) return dotted[1];
  const hex = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return null;
}

/** True if the IP address is private, loopback, link-local, reserved or otherwise internal. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}

// ─── Hostnames ───────────────────────────────────────────────────────────────

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home.arpa',
];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Validates a URL before any connection: http(s) only, no internal hostnames, and IP literals
 * checked directly (a literal is dialled without a DNS lookup, so the lookup guard never sees it).
 */
export function assertAllowedUrl(url: URL, options: SsrfOptions = {}): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedTargetError(`Only http and https URLs can be requested (got ${url.protocol})`);
  }
  if (options.allowPrivateNetwork) return;

  const host = stripBrackets(url.hostname.toLowerCase()).replace(/\.$/, '');
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedTargetError(
        `Requests to private or internal addresses are blocked (${host})`,
      );
    }
    return;
  }
  if (
    BLOCKED_HOSTS.has(host) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    !host.includes('.')
  ) {
    throw new BlockedTargetError(`Requests to internal hostnames are blocked (${host})`);
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

type LookupFunction = (
  hostname: string,
  options: { all?: boolean; family?: number },
  callback: LookupCallback,
) => void;

/**
 * A `lookup` for net/tls sockets that refuses to connect if ANY resolved address is internal.
 * Rejecting on any (not just the first) stops a hostname that returns both a public and a
 * private address from being used to reach the private one.
 */
export function createGuardedLookup(options: SsrfOptions = {}): LookupFunction {
  return (hostname, lookupOptions, callback) => {
    dnsLookup(hostname, { all: true, family: lookupOptions.family ?? 0 }, (err, addresses) => {
      if (err) return callback(err, []);
      if (addresses.length === 0) {
        return callback(
          Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }),
          [],
        );
      }
      if (!options.allowPrivateNetwork) {
        const bad = addresses.find((a) => isBlockedAddress(a.address));
        if (bad) {
          return callback(
            new BlockedTargetError(
              `${hostname} resolves to a private or internal address (${bad.address})`,
            ),
            [],
          );
        }
      }
      if (lookupOptions.all) return callback(null, addresses);
      const first = addresses[0]!;
      return callback(null, first.address, first.family);
    });
  };
}
