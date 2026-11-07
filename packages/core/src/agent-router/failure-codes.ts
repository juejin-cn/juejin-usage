/** Only these fixed diagnostics may cross the subscription worker boundary.
 * Never forward raw provider messages, project IDs, metadata or credentials. */
export const FAILURE_HEADER = 'x-jusage-failure-code';
const codes: Record<string, readonly number[]> = {
  UPSTREAM_MODEL_NOT_IN_CATALOG: [404],
  UPSTREAM_RATE_LIMITED: [429],
  UPSTREAM_QUOTA_EXHAUSTED: [403, 429],
  UPSTREAM_RESOURCE_EXHAUSTED: [429],
  UPSTREAM_CAPACITY_EXHAUSTED: [429, 503],
  UPSTREAM_INVALID_ARGUMENT: [400],
  UPSTREAM_PERMISSION_DENIED: [403],
};
export function verifiedFailureCode(value: unknown, status: number): string | undefined {
  return typeof value === 'string' && Object.hasOwn(codes, value) && codes[value].includes(status) ? value : undefined;
}
export function failureHeaders(value: unknown, status: number): Record<string, string> {
  const code = verifiedFailureCode(value, status);
  return code ? { [FAILURE_HEADER]: code } : {};
}
