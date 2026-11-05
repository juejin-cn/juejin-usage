/** Hit testing stays in logical pixels; atlas coordinates are always 192×208. */
export function opaqueAt(pixels, cell, layout, x, y) {
  const sx=x-layout.spriteLeft, sy=y-layout.spriteTop;
  if (!pixels || sx<0 || sy<0 || sx>=layout.spriteWidth || sy>=layout.spriteHeight) return false;
  let px=Math.floor(sx/layout.spriteWidth*192);
  if(cell.mirrorX)px=191-px;
  const py=Math.floor(sy/layout.spriteHeight*208);
  return pixels.data[((cell.sourceY+py)*pixels.width+cell.sourceX+px)*4+3]>20;
}
