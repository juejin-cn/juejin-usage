/** Feedback only compares readings from the same local day and runtime. */
export function petFeedback(previous, current, sameRuntime = true) {
  if (!sameRuntime || !previous || previous.day !== current.day) return null;
  const delta = current.tokens - previous.tokens;
  return Number.isFinite(delta) && delta > 0 ? `+${Math.round(delta).toLocaleString()} tokens` : null;
}
export function todayReading(body, now = new Date()) {
  const tokens = body?.data?.todayTokens;
  if (body?.success !== true || !Number.isFinite(tokens) || tokens < 0) return null;
  return { day: `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`, tokens };
}
