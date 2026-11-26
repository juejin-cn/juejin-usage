import { useCallback, useEffect, useState } from 'react';
import {
  fetchUsageDevices,
  getApiBearer,
  isCliBackend,
  type UsageDeviceInfo,
} from '@/lib/api';
import {
  DEVICE_FILTER_CHANGED_EVENT,
  DEVICE_FILTER_OWNER_CHANGED_EVENT,
  getActiveDeviceIds,
  hydrateActiveDeviceIds,
  resolveDeviceFilterUserKey,
  saveDeviceFilter,
  setActiveDeviceIds,
} from '@/lib/device-filter';
import { DATA_SYNCED_EVENT, dispatchDataSynced } from '@/lib/shell-events';

export function useDeviceFilter() {
  const cliBackend = isCliBackend();
  const [devices, setDevices] = useState<UsageDeviceInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [activeCount, setActiveCount] = useState(0);
  const [userKey, setUserKey] = useState(() => resolveDeviceFilterUserKey());
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    const onOwner = () => setUserKey(resolveDeviceFilterUserKey());
    window.addEventListener(DEVICE_FILTER_OWNER_CHANGED_EVENT, onOwner);
    return () => {
      window.removeEventListener(DEVICE_FILTER_OWNER_CHANGED_EVENT, onOwner);
    };
  }, []);

  useEffect(() => {
    if (!copiedId) return;
    const timer = window.setTimeout(() => setCopiedId(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copiedId]);

  const copyDeviceId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id.toLowerCase());
    } catch {
      setCopiedId(null);
    }
  };
  const refreshDevices = useCallback(async () => {
    if (cliBackend) return;
    if (!getApiBearer()) {
      setDevices([]);
      setActiveCount(0);
      return;
    }
    try {
      const list = await fetchUsageDevices();
      setDevices(list);
      const key = resolveDeviceFilterUserKey();
      setUserKey(key);
      const stored = hydrateActiveDeviceIds(key);
      const valid = new Set(list.map((d) => d.device_id.toLowerCase()));
      const pruned = stored.filter((id) => valid.has(id.toLowerCase()));
      if (pruned.length !== stored.length) {
        saveDeviceFilter(key, pruned);
        setActiveDeviceIds(pruned);
      }
      setActiveCount(getActiveDeviceIds().length);
    } catch {
      setDevices([]);
    }
  }, [cliBackend]);

  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices, userKey]);

  useEffect(() => {
    const onChanged = () => setActiveCount(getActiveDeviceIds().length);
    window.addEventListener(DEVICE_FILTER_CHANGED_EVENT, onChanged);
    const onSynced = () => {
      void refreshDevices();
    };
    window.addEventListener(DATA_SYNCED_EVENT, onSynced);
    return () => {
      window.removeEventListener(DEVICE_FILTER_CHANGED_EVENT, onChanged);
      window.removeEventListener(DATA_SYNCED_EVENT, onSynced);
    };
  }, [refreshDevices]);

  const openModal = () => {
    setDraft(new Set(getActiveDeviceIds().map((id) => id.toLowerCase())));
    setOpen(true);
  };

  const toggle = (id: string, checked: boolean) => {
    const key = id.toLowerCase();
    setDraft((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const apply = () => {
    const key = resolveDeviceFilterUserKey();
    const ids = [...draft];
    saveDeviceFilter(key, ids);
    setActiveDeviceIds(ids);
    setActiveCount(ids.length);
    setOpen(false);
    dispatchDataSynced();
  };

  return { visible: !cliBackend && devices.length > 1, devices, open, setOpen, openModal, activeCount,
    draft, setDraft, toggle, apply, copiedId, copyDeviceId };
}
