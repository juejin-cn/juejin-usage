import { useEffect, useRef } from 'react';

const label = 'Juejin Usage';

// Ordered dithering keeps the transition from solid ink to paper on a square grid.
const bayer = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

export function DownloadWordmark() {
  const ref = useRef<HTMLCanvasElement>(null);

  const dropperRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    const dropper = dropperRef.current;
    if (!canvas || !ctx || !dropper) return;
    const ink = document.createElement('canvas');
    const mask = ink.getContext('2d', { willReadFrequently: true });
    if (!mask) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let frame = 0;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;
    let strength = 0;
    let hovering = false;
    let angle = -30;

    function schedule() {
      if (visible && !document.hidden && !frame) frame = requestAnimationFrame(draw);
    }

    function draw() {
      frame = 0;
      if (!ctx || !canvas) return;
      const target = hovering && !motion.matches ? 1 : 0;
      x += (targetX - x) * 0.24;
      y += (targetY - y) * 0.24;
      strength += (target - strength) * 0.22;
      if (Math.abs(target - strength) < 0.01) strength = target;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(ink, 0, 0);
      if (strength > 0) {
        const radius = canvas.width * 0.115;
        const light = ctx.createRadialGradient(x, y, 0, x, y, radius);
        light.addColorStop(0, `rgba(12,13,16,${strength * 0.92})`);
        light.addColorStop(0.48, `rgba(30,31,34,${strength * 0.56})`);
        light.addColorStop(1, 'transparent');
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = light;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (strength !== target || (hovering && Math.hypot(targetX - x, targetY - y) > 0.1)) schedule();
    }

    function resize() {
      if (!visible || !canvas || !mask) return;
      const width = Math.min(960, Math.round(canvas.clientWidth));
      if (width < 1) return;
      const height = Math.max(1, Math.round(width * canvas.clientHeight / canvas.clientWidth));
      if (width === ink.width && height === ink.height && canvas.width === width) {
        schedule();
        return;
      }
      canvas.width = ink.width = width;
      canvas.height = ink.height = height;
      mask.font = '900 100px system-ui';
      const fontSize = width * 98 / mask.measureText(label).width;
      mask.font = `900 ${fontSize}px system-ui`;
      mask.textAlign = 'center';
      const metrics = mask.measureText(label);
      const baseline = height - metrics.actualBoundingBoxDescent;
      const top = baseline - metrics.actualBoundingBoxAscent;
      mask.fillText(label, width / 2, baseline);
      const image = mask.getImageData(0, 0, width, height);
      const glyphHeight = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
      let lastInkRow = -1;
      for (let row = 0; row < height; row++) {
        const depth = (row - top) / glyphHeight;
        const coverage = Math.max(0, Math.min(1, (1.04 - depth) / 0.55));
        for (let col = 0; col < width; col++) {
          const i = (row * width + col) * 4;
          const threshold = (bayer[(row % 4) * 4 + col % 4] + 0.5) / 16;
          image.data[i + 3] = image.data[i + 3] >= 128 && coverage >= threshold ? 255 : 0;
          if (image.data[i + 3]) lastInkRow = row;
          image.data[i] = image.data[i + 1] = image.data[i + 2] = 218;
        }
      }
      // Dithering can erase the final rows of a descender. Align the visible ink.
      mask.clearRect(0, 0, width, height);
      mask.putImageData(image, 0, height - 1 - lastInkRow);
      schedule();
    }

    function move(event: PointerEvent) {
      if (!canvas || !dropper || event.pointerType === 'touch' || motion.matches) return;
      const rect = canvas.getBoundingClientRect();
      const localX = event.clientX - rect.left;
      const localY = event.clientY - rect.top;
      const nextX = localX * canvas.width / rect.width;
      const nextY = localY * canvas.height / rect.height;
      if (hovering && Math.hypot(nextX - targetX, nextY - targetY) > 1) {
        const heading = Math.atan2(nextY - targetY, nextX - targetX) * 180 / Math.PI;
        angle += (((heading - angle) % 360 + 540) % 360 - 180) * 0.32;
      }
      dropper.style.transform = `translate(${localX - 48}px, ${localY - 14}px) rotate(${angle}deg)`;
      dropper.style.opacity = '1';
      canvas.style.cursor = 'none';
      targetX = nextX;
      targetY = nextY;
      if (!hovering) {
        x = targetX;
        y = targetY;
      }
      hovering = true;
      schedule();
    }
    function sample(event: PointerEvent) {
      if (!canvas || !ctx || !dropper || event.button !== 0) return;
      move(event);
      if (!hovering) return;
      const px = Math.max(0, Math.min(canvas.width - 1, Math.floor(targetX)));
      const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(targetY)));
      const [r, g, b, alpha] = ctx.getImageData(px, py, 1, 1).data;
      const dark = document.documentElement.classList.contains('dark');
      const rgb = [r, g, b].map(value => dark ? 255 - value : value);
      dropper.style.setProperty('--sample', alpha ? `rgb(${rgb.join(' ')})` : 'var(--background)');
      dropper.dataset.pressed = 'true';
    }
    function release() {
      if (dropper) delete dropper.dataset.pressed;
    }
    function rest() {
      if (canvas) canvas.style.cursor = '';
      if (dropper) dropper.style.opacity = '0';
      release();
      hovering = false;
      schedule();
    }
    const viewport = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) resize();
      else {
        rest();
        strength = 0;
        cancelAnimationFrame(frame);
        frame = 0;
      }
    });
    const bounds = new ResizeObserver(resize);
    bounds.observe(canvas);
    viewport.observe(canvas);
    canvas.addEventListener('pointerenter', move);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerdown', sample);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', rest);
    canvas.addEventListener('pointerleave', rest);
    motion.addEventListener('change', rest);
    document.addEventListener('visibilitychange', rest);
    return () => {
      viewport.disconnect();
      bounds.disconnect();
      cancelAnimationFrame(frame);
      canvas.style.cursor = '';
      canvas.removeEventListener('pointerenter', move);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerdown', sample);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', rest);
      canvas.removeEventListener('pointerleave', rest);
      motion.removeEventListener('change', rest);
      document.removeEventListener('visibilitychange', rest);
    };
  }, []);

  return (
    <footer className="mt-14 overflow-hidden pt-6">
      <div className="relative">
        <canvas ref={ref} role="img" aria-label={label} className="block aspect-[6/1] w-full [image-rendering:pixelated] dark:invert">{label}</canvas>
        <svg ref={dropperRef} aria-hidden="true" width="50" height="28" viewBox="-48 -14 50 28"
          className="group origin-[48px_14px] opacity-0 transition-opacity duration-[120ms] pointer-events-none absolute left-0 top-0 text-foreground">
          <path fill="currentColor" d="M0 0 L-18 -3 L-18 3 Z M-21 -5 H-16 V5 H-21 Z" />
          <g className="origin-[-18px_0] transition-transform duration-[140ms] ease-out group-data-pressed:scale-x-[.92] group-data-pressed:scale-y-[.76]">
            <ellipse cx="-31" cy="0" rx="13" ry="11" fill="currentColor" />
            <ellipse cx="-35" cy="-3" rx="5" ry="2.8" fill="var(--sample, #a1a1aa)" />
          </g>
        </svg>
      </div>
    </footer>
  );
}
