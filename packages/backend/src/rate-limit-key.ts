// @kgpacks/backend — rate-limit client-IP key generation.
//
// Mirrors the reference `rate_limit._get_client_ip`: by default the rate-limit key
// is the direct socket address. `X-Forwarded-For` (leftmost / original client) is
// honored ONLY when the direct peer falls within a configured trusted-proxy
// network (`WIKIGR_TRUSTED_PROXIES`), preventing clients from spoofing their key
// via header injection.

import type { FastifyRequest } from 'fastify';
import ipaddr from 'ipaddr.js';

type ParsedAddress = ReturnType<typeof ipaddr.parse>;
type Network = [ParsedAddress, number];

/** Parses CIDR / bare-IP trusted-proxy entries; invalid entries are skipped. */
export function parseTrustedNetworks(entries: readonly string[]): Network[] {
  const networks: Network[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry.length === 0) continue;
    try {
      if (entry.includes('/')) {
        networks.push(ipaddr.parseCIDR(entry) as Network);
      } else {
        const addr = ipaddr.parse(entry);
        networks.push([addr, addr.kind() === 'ipv4' ? 32 : 128]);
      }
    } catch {
      // Ignore malformed entries (matches the reference warning-and-skip behavior).
    }
  }
  return networks;
}

function inTrustedNetwork(host: string, networks: Network[]): boolean {
  let addr: ParsedAddress;
  try {
    addr = ipaddr.parse(host);
  } catch {
    return false;
  }
  for (const net of networks) {
    try {
      if (addr.kind() === net[0].kind() && addr.match(net)) return true;
    } catch {
      // Different address families cannot match; keep checking.
    }
  }
  return false;
}

/**
 * Builds a `@fastify/rate-limit` `keyGenerator` honoring the trusted-proxy policy.
 * Fastify's `request.ip` is the direct socket address (the server does not enable
 * Fastify `trustProxy`, so `X-Forwarded-For` parsing stays under this control).
 */
export function makeKeyGenerator(
  trustedProxies: readonly string[],
): (request: FastifyRequest) => string {
  const networks = parseTrustedNetworks(trustedProxies);

  return (request: FastifyRequest): string => {
    const directHost = request.ip || '127.0.0.1';
    if (networks.length === 0) return directHost;
    if (inTrustedNetwork(directHost, networks)) {
      const forwarded = request.headers['x-forwarded-for'];
      const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      if (value) {
        const first = value.split(',')[0]?.trim();
        if (first) return first;
      }
    }
    return directHost;
  };
}
