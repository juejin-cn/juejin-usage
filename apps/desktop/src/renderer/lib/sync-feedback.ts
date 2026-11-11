interface SyncFeedbackInput {
  ok: boolean;
  cloudUpload?: { status: 'uploaded' | 'pending' | 'skipped' | 'failed' | 'unknown' };
}

/** Local success cannot promise that the cloud query has caught up. */
export function syncFeedback(result: SyncFeedbackInput): {
  title: string;
  variant: 'success' | 'warning' | 'danger' | 'default';
} {
  if (!result.ok) return { title: '同步失败，请稍后重试', variant: 'danger' };
  switch (result.cloudUpload?.status) {
    case 'uploaded': return { title: '本地同步完成，云端上报已完成', variant: 'success' };
    case 'pending': return { title: '本地同步完成，云端仍有数据待补报', variant: 'warning' };
    case 'failed': return { title: '本地同步完成，云端上报失败，将自动重试', variant: 'warning' };
    case 'skipped': return { title: '本地同步完成，未上报云端，请检查账号关联与同步设置', variant: 'default' };
    default: return { title: '本地同步完成，云端上报状态未确认', variant: 'default' };
  }
}
