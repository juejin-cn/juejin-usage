import type { DoctorReport } from '@juejin-opensource/jusage-core';

function shouldUseColors(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
}

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function c(color: keyof typeof colors, text: string, enabled: boolean): string {
  if (!enabled) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

export function printDoctorReport(report: DoctorReport): void {
  const useColor = shouldUseColors();

  console.log();
  console.log(
    c(
      'bold',
      `🩺 ${c('cyan', 'JUsage Doctor', useColor)} - 系统环境与数据源全面诊断`,
      useColor,
    ),
  );
  console.log(c('dim', `诊断时间: ${new Date(report.timestamp).toLocaleString()}`, useColor));
  console.log();

  for (const cat of report.categories) {
    let catIcon = c('green', '[✓]', useColor);
    if (cat.status === 'error') {
      catIcon = c('red', '[✗]', useColor);
    } else if (cat.status === 'warn') {
      catIcon = c('yellow', '[!]', useColor);
    }

    console.log(`${catIcon} ${c('bold', cat.title, useColor)}`);

    for (const item of cat.items) {
      let itemIcon = c('green', '✓', useColor);
      if (item.status === 'error') itemIcon = c('red', '✗', useColor);
      else if (item.status === 'warn') itemIcon = c('yellow', '!', useColor);
      else if (item.status === 'info') itemIcon = c('gray', '-', useColor);

      console.log(`  ${itemIcon} ${item.name}: ${item.message}`);
      if (item.detail) {
        console.log(`    ${c('dim', item.detail, useColor)}`);
      }
    }
    console.log();
  }

  // Display collectors breakdown if any
  const detected = report.collectors.items.filter((i) => i.present);
  const undetected = report.collectors.items.filter((i) => !i.present);

  console.log(
    `${c('cyan', '📊 AI 编程工具探测详情', useColor)} ` +
      `(${c('bold', String(detected.length), useColor)} / ${report.collectors.total} 款已就绪)`,
  );

  if (detected.length > 0) {
    for (const d of detected) {
      const hookText = d.hookStatus ? ` ${c('cyan', `[Hook: ${d.hookStatus}]`, useColor)}` : '';
      console.log(`  ${c('green', '✓', useColor)} ${d.displayName}${hookText}`);
    }
  } else {
    console.log(`  ${c('yellow', '!', useColor)} 尚未检测到任何支持的 AI 工具`);
  }

  if (undetected.length > 0) {
    const unNames = undetected.map((u) => u.displayName).join(', ');
    console.log(
      `  ${c('dim', `- 未探测到日志的工具 (${undetected.length}): ${unNames}`, useColor)}`,
    );
  }
  console.log();

  // Suggestions block if any warnings/errors
  if (report.summary.suggestions.length > 0) {
    console.log(c('bold', c('yellow', '💡 诊断发现以下建议项:', useColor), useColor));
    for (const suggestion of report.summary.suggestions) {
      console.log(`  • ${suggestion}`);
    }
    console.log();
  }

  // Summary conclusion line
  if (report.summary.status === 'ok') {
    console.log(
      c(
        'green',
        `🎉 诊断完成: ${report.summary.okCount} 项正常, 0 个错误, 0 个警告。所有核心组件运行良好！`,
        useColor,
      ),
    );
  } else if (report.summary.status === 'warn') {
    console.log(
      c(
        'yellow',
        `⚠️  诊断完成: ${report.summary.warnCount} 个提醒事项，请根据上方建议进行调整。`,
        useColor,
      ),
    );
  } else {
    console.log(
      c(
        'red',
        `❌ 诊断完成: 发现 ${report.summary.errorCount} 个异常项，请优先处理上方错误。`,
        useColor,
      ),
    );
  }
  console.log();
}
