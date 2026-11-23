import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  beforeLoad: ({ location }) => {
    // Preserve association query. Do NOT set raw `href` — it skips basepath
    // (/aiusage) and can leave the SPA for juejin.cn/dashboard.
    const search = Object.fromEntries(new URLSearchParams(location.searchStr));
    throw redirect({
      to: '/dashboard',
      replace: true,
      search: search as never,
    });
  },
});
