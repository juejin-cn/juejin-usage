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
/** Hit testing stays in logical pixels; atlas coordinates are always 192×208. */
export function opaqueAt(pixels, cell, layout, x, y) {
  const sx=x-layout.spriteLeft, sy=y-layout.spriteTop;
  if (!pixels || sx<0 || sy<0 || sx>=layout.spriteWidth || sy>=layout.spriteHeight) return false;
  let px=Math.floor(sx/layout.spriteWidth*192);
  if(cell.mirrorX)px=191-px;
  const py=Math.floor(sy/layout.spriteHeight*208);
  return pixels.data[((cell.sourceY+py)*pixels.width+cell.sourceX+px)*4+3]>20;
}
