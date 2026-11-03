import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getActivityHeatmapLayout as dashboardLayout, ACTIVITY_HEATMAP_LAYOUT } from './activity-heatmap.ts';
import { getActivityHeatmapLayout as desktopLayout } from '../../../../apps/desktop/src/renderer/lib/activity-heatmap.ts';

for (const [name, layout] of [['dashboard/Tauri', dashboardLayout], ['Electron', desktopLayout]] as const) {
  test(`${name}: all cells and selection padding fit at every responsive width`, () => {
    const { labelWidth, gap, edgePadding } = ACTIVITY_HEATMAP_LAYOUT;
    for (const maxWeeks of [1, 26, 52]) {
      for (let width = 41; width <= 4096; width++) {
        const { cellSize, visibleWeeks } = layout(width, maxWeeks);
        const usedWidth = edgePadding * 2 + labelWidth + visibleWeeks * (cellSize + gap);
        assert.ok(usedWidth <= width, `width=${width}, weeks=${visibleWeeks}, actual=${usedWidth}`);
        assert.ok(visibleWeeks >= 1 && visibleWeeks <= maxWeeks);
        assert.ok(cellSize >= 1);
      }
    }
  });
  test(`${name}: the last column does not sneak past the full-year breakpoint`, () => {
    // 52 cells × (15px + 4px gap), weekday labels, and 8px safety on each edge.
    assert.deepEqual(layout(1024, 52), { visibleWeeks: 52, cellSize: 15 });
    assert.deepEqual(layout(1023, 52), { visibleWeeks: 51, cellSize: 15 });
  });
}
