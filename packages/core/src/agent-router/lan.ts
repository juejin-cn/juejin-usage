import { networkInterfaces } from 'node:os';

/** RFC 1918, link-local and CGNAT ranges; public addresses are never accepted. */
export function privateIPv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

export function loopbackAddress(address: string | undefined): boolean {
  const value = (address ?? '').replace(/^::ffff:/, '');
  return value === '127.0.0.1' || value === '::1';
}

let cached: { at: number; addresses: string[] } | undefined;
export function lanAddresses(now = Date.now()): string[] {
  if (cached && now - cached.at < 5000) return cached.addresses;
  const addresses = Object.values(networkInterfaces()).flat()
    .flatMap(item => item && item.family === 'IPv4' && !item.internal && privateIPv4(item.address) ? [item.address] : []);
  cached = { at: now, addresses: [...new Set(addresses)] };
  return cached.addresses;
}
