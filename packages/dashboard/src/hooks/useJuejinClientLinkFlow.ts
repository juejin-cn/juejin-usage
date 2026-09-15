import { useCallback, useEffect, useRef, useState } from 'react';
import { Toast, ToastQueue } from '@heroui/react';
import { isCliBackend, saveConfig, setApiBearer } from '@/lib/api';
import { setDeviceFilterOwner } from '@/lib/device-filter';
import {
  fetchJuejinUserProfile,
  openCliLocalWrite,
  resolveClientLinkSearch,
  stripClientLinkQuery,
  writeUserIdToDesktop,
} from '@/lib/juejin-client-link';
import { dispatchJuejinLinkChanged } from '@/lib/shell-events';

export type JuejinAuthStatus =
  | 'loading'
  | 'authenticated'
  | 'unauthenticated';

/**
 * Online: tud-session on first load; with `login_from_client` → protocol / local panel.
 * CLI panel: `user_id` (encrypted) + profile → PUT tud-config (same origin).
 */
export function useJuejinClientLinkFlow(): {
  authStatus: JuejinAuthStatus;
  userId: string | null;
  userName: string;
  avatarLarge: string;
  refreshAuth: () => Promise<boolean>;
  toastQueue: ToastQueue;
  ToastProvider: typeof Toast.Provider;
} {
  const [toastQueue] = useState(
    () => new ToastQueue({ maxVisibleToasts: 2 }),
  );
  const [authStatus, setAuthStatus] = useState<JuejinAuthStatus>(() =>
    isCliBackend() ? 'unauthenticated' : 'loading',
  );
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState('');
  const [avatarLarge, setAvatarLarge] = useState('');
  const ranRef = useRef(false);

  const fetchAndApplyServerProfile = useCallback(async () => {
    let profile: Awaited<ReturnType<typeof fetchJuejinUserProfile>> = null;
    setAuthStatus('loading');
    try {
      profile = await fetchJuejinUserProfile();
    } catch {
      profile = null;
    }

    if (!profile) {
      setApiBearer(null);
      setDeviceFilterOwner(null);
      setUserId(null);
      setUserName('');
      setAvatarLarge('');
      setAuthStatus('unauthenticated');
      return null;
    }

    setApiBearer(profile.userId);
    setDeviceFilterOwner(profile.originUserId);
    setUserId(profile.originUserId);
    setUserName(profile.userName);
    setAvatarLarge(profile.avatarLarge);
    setAuthStatus('authenticated');
    return profile;
  }, []);

  const refreshAuth = useCallback(async () => {
    if (isCliBackend()) return false;
    return Boolean(await fetchAndApplyServerProfile());
  }, [fetchAndApplyServerProfile]);

  useEffect(() => {
    if (ranRef.current) return;
    const {
      loginFromClient,
      port,
      userId: queryUserId,
      originUserId: queryOriginUserId,
      userName: queryUserName,
      avatarLarge: queryAvatarLarge,
    } = resolveClientLinkSearch();

    // CLI local panel: write encrypted user_id from Query (opened by online page).
    if (isCliBackend() && queryUserId) {
      ranRef.current = true;
      void (async () => {
        try {
          await saveConfig({
            juejin: {
              enabled: true,
              token: queryUserId,
              originUserId: queryOriginUserId || undefined,
              userName: queryUserName || undefined,
              avatarLarge: queryAvatarLarge || undefined,
            },
          });
          stripClientLinkQuery();
          setUserId(queryOriginUserId || queryUserId);
          setUserName(queryUserName);
          setAvatarLarge(queryAvatarLarge);
          setAuthStatus('authenticated');
          dispatchJuejinLinkChanged();
          toastQueue.add({
            title: '登录成功',
            variant: 'success',
          });
        } catch (e) {
          setAuthStatus('unauthenticated');
          toastQueue.add({
            title: '写入失败',
            description:
              e instanceof Error ? e.message : '请确认本机面板服务已启动',
            variant: 'danger',
          });
        }
      })();
      return;
    }

    // CLI without query write: no cookie-based session.
    if (isCliBackend()) {
      ranRef.current = true;
      setAuthStatus('unauthenticated');
      return;
    }

    // Online (server build): always fetch session on first load.
    ranRef.current = true;

    void (async () => {
      const profile = await fetchAndApplyServerProfile();

      if (!profile) {
        if (loginFromClient) {
          toastQueue.add({
            title: '请先登录掘金账号',
            description: '登录后再打开此链接以关联客户端',
            variant: 'danger',
          });
        }
        return;
      }

      if (!loginFromClient) return;

      const linkProfile = {
        originUserId: profile.originUserId,
        userName: profile.userName,
        avatarLarge: profile.avatarLarge,
      };

      if (loginFromClient === 'desktop') {
        writeUserIdToDesktop(profile.userId, linkProfile);
        stripClientLinkQuery();
        toastQueue.add({
          title: '登录成功',
          variant: 'success',
        });
        return;
      }

      toastQueue.add({
        title: '登录成功',
        variant: 'success',
      });
      // Same-tab return (B → A); delayed so toast can paint.
      openCliLocalWrite(profile.userId, port, linkProfile);
    })();
  }, [fetchAndApplyServerProfile, toastQueue]);

  // Juejin's login UI lives on juejin.cn. The dashboard opens it in another
  // tab; re-check the cookie-backed session as soon as the user returns.
  useEffect(() => {
    if (isCliBackend() || authStatus !== 'unauthenticated') return;

    let inFlight = false;
    const recheck = () => {
      if (inFlight) return;
      inFlight = true;
      void refreshAuth().finally(() => {
        inFlight = false;
      });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') recheck();
    };

    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [authStatus, refreshAuth]);

  return {
    authStatus,
    userId,
    userName,
    avatarLarge,
    refreshAuth,
    toastQueue,
    ToastProvider: Toast.Provider,
  };
}
