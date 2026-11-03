import { createPetPreferenceSaver, type PetPreferenceChanges } from '@/lib/pet-preference-saver';
import { Button, Checkbox, Description, Label, ListBox, NumberField, Select, Slider } from '@heroui/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getTauriDesktopBridge } from '@/lib/tauri-desktop';
import { StatusBanner } from './StatusBanner';
import { TauriPetSelectPreview as PetSelectPreview } from './TauriPetSelectPreview';
import { petRequest, type PetCatalog, type PetDefinition as DesktopPetDefinition } from '@/lib/tauri-pets';

const CUSTOM_PET_DOCS_URL = 'https://gitee.com/juejin-cn/juejin-usage/blob/main/README.md#%E6%A1%8C%E9%9D%A2%E5%AE%A0%E7%89%A9%E5%8F%AF%E9%80%89';
const BUILTINS: DesktopPetDefinition[] = [
  {id:'hawking',displayName:'Hawking',description:'橙色、锐眼的土星伙伴',source:'builtin'},
  {id:'yoyo',displayName:'Yoyo',description:'蓝色、胸前带星标的伙伴',source:'builtin'},
  {id:'click',displayName:'Click',description:'青绿色、亮眼的克里克伙伴',source:'builtin'},
];

export function TauriPetSettings() {
  const bridge = getTauriDesktopBridge();
  const [catalog,setCatalog] = useState<PetCatalog>({pets:BUILTINS});
  const [remote,setRemote] = useState<DesktopPetDefinition[]>([]);
  const [error,setError] = useState<string|null>(null);
  const [refreshing,setRefreshing] = useState(false);
  const [installing,setInstalling] = useState<string|null>(null);
  const alive = useRef(false);
  const refreshBusy = useRef(false);
  const installBusy = useRef(false);
  const refresh = useCallback(async () => {
    if(refreshBusy.current)return;
    refreshBusy.current=true;
    if(alive.current){setRefreshing(true);setError(null);}
    try {
      const local = await petRequest<PetCatalog>();
      if(alive.current)setCatalog(local);
      const community = await petRequest<PetCatalog>('/remote',{});
      if(alive.current){setRemote(community.pets);setError(community.error??null);}
    } catch(reason) {if(alive.current)setError(reason instanceof Error?reason.message:'读取宠物目录失败');}
    finally {refreshBusy.current=false;if(alive.current)setRefreshing(false);}
  },[]);
  useEffect(()=>{alive.current=true;if(bridge)void refresh();return()=>{alive.current=false;};},[bridge,refresh]);
  const install = async (id:string) => {
    if(installBusy.current)return;
    installBusy.current=true;setInstalling(id);setError(null);
    try {
      await petRequest('/install',{id});
      const local=await petRequest<PetCatalog>();
      if(alive.current)setCatalog(local);
    } catch(reason){if(alive.current)setError(reason instanceof Error?reason.message:'下载宠物失败');}
    finally {installBusy.current=false;if(alive.current)setInstalling(null);}
  };
  if(!bridge)return null;
  const pets=[...catalog.pets.map(p=>({...p,description:p.description??BUILTINS.find(b=>b.id===p.id)?.description??'本地宠物'})),...remote.filter(p=>!catalog.pets.some(local=>local.id===p.id))];
  return <PetSettingsPanel pets={pets} invalidPets={catalog.invalidPets??[]} catalogError={error}
    installingPetId={installing} refreshingPets={refreshing}
    onInstallRemotePet={id=>void install(id)} onRefreshPets={()=>void refresh()} />;
}

function PetSettingsPanel({
  catalogSelectedPetId,
  catalogError,
  installingPetId,
  invalidPets,
  pets,
  refreshingPets,
  onInstallRemotePet,
  onRefreshPets,
}: {
  catalogSelectedPetId?: string;
  catalogError: string | null;
  installingPetId: string | null;
  invalidPets: Array<{ directory: string; reason: string }>;
  pets: DesktopPetDefinition[];
  refreshingPets: boolean;
  onInstallRemotePet: (id: string) => void;
  onRefreshPets: () => void;
}) {
  const bridge = getTauriDesktopBridge()!;
  const [enabled, setEnabled] = useState(false);
  const [selectedPetId, setSelectedPetId] = useState('hawking');
  const [scale, setScale] = useState(50);
  const [frameIntervalMs, setFrameIntervalMs] = useState(180);
  const [autoMoveEnabled, setAutoMoveEnabled] = useState(true);
  const [autoMoveIntervalMinutes, setAutoMoveIntervalMinutes] = useState(2);
  const [syncFeedbackEnabled, setSyncFeedbackEnabled] = useState(false);
  const [syncFeedbackDurationSec, setSyncFeedbackDurationSec] = useState(3);
  const saveTimer = useRef<number | null>(null);
  const editingSlider = useRef(false);
  const pendingPreferenceChanges = useRef<PetPreferenceChanges>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [petMenuOpen, setPetMenuOpen] = useState(false);
  const keepPetMenuOpen = useRef(false);
  const latestCatalogSelectedPetId = useRef(catalogSelectedPetId);
  const [preferenceSaver] = useState(() => createPetPreferenceSaver(
    (changes) => bridge.setPetPreferences(changes),
    (saved) => {
      setScale(Math.round(saved.scale * 100));
      setFrameIntervalMs(saved.frameIntervalMs);
      setAutoMoveEnabled(saved.autoMoveEnabled);
      setAutoMoveIntervalMinutes(saved.autoMoveIntervalMinutes);
      setSyncFeedbackEnabled(saved.syncFeedbackEnabled);
      setSyncFeedbackDurationSec(saved.syncFeedbackDurationSec);
    },
    (reason) => setError(reason instanceof Error ? reason.message : '更新桌面宠物设置失败'),
    () => editingSlider.current || saveTimer.current !== null,
  ));

  useEffect(() => {
    latestCatalogSelectedPetId.current = catalogSelectedPetId;
    if (catalogSelectedPetId) setSelectedPetId(catalogSelectedPetId);
  }, [catalogSelectedPetId]);

  // While a community pet downloads, ignore Select close attempts so the menu stays open.
  useEffect(() => {
    if (installingPetId) {
      keepPetMenuOpen.current = true;
      setPetMenuOpen(true);
      return;
    }
    if (keepPetMenuOpen.current) {
      keepPetMenuOpen.current = false;
      setPetMenuOpen(true);
    }
  }, [installingPetId]);

  useEffect(() => {
    let cancelled = false;
    const applyPref = (
      pref: {
        enabled: boolean;
        selectedPetId: string;
        scale: number;
        frameIntervalMs: number;
        autoMoveEnabled: boolean;
        autoMoveIntervalMinutes: number;
        syncFeedbackEnabled: boolean;
        syncFeedbackDurationSec: number;
      },
      skipMotion = false,
    ) => {
      setEnabled(pref.enabled);
      setSelectedPetId(pref.selectedPetId);
      if (skipMotion) return;
      setScale(Math.round(pref.scale * 100));
      setFrameIntervalMs(pref.frameIntervalMs);
      setAutoMoveEnabled(pref.autoMoveEnabled);
      setAutoMoveIntervalMinutes(pref.autoMoveIntervalMinutes);
      setSyncFeedbackEnabled(pref.syncFeedbackEnabled);
      setSyncFeedbackDurationSec(pref.syncFeedbackDurationSec);
    };

    void bridge
      .getPetPreferences()
      .then((pref) => {
        if (!cancelled) {
          applyPref({
            ...pref,
            selectedPetId: latestCatalogSelectedPetId.current ?? pref.selectedPetId,
          });
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(
            reason instanceof Error ? reason.message : '加载桌面宠物设置失败',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    const unsubscribe = bridge.onPetPreferences((pref) => {
      applyPref(pref, preferenceSaver.busy);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const onChange = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    try {
      await bridge.setPetPreferences({enabled:next});
    } catch (reason) {
      setEnabled(previous);
      setError(
        reason instanceof Error ? reason.message : '更新桌面宠物设置失败',
      );
    }
  };

  const onSelectedPetChange = async (value: string | number | null) => {
    if (value === null) return;
    const next = String(value);
    if (next.startsWith('invalid:')) return;
    const pet = pets.find((item) => item.id === next);
    if (!pet || pet.source === 'remote') return;
    const previous = selectedPetId;
    setSelectedPetId(next);
    setError(null);
    try {
      await bridge.setPetPreferences({selectedPetId:next});
    } catch (reason) {
      setSelectedPetId(previous);
      setError(
        reason instanceof Error ? reason.message : '切换桌面宠物失败',
      );
    }
  };

  const savePetPreferences = (changes: PetPreferenceChanges) => {
    setError(null);
    preferenceSaver.save(changes);
  };

  const schedulePetPreferenceSave = (changes: PetPreferenceChanges) => {
    preferenceSaver.invalidate();
    pendingPreferenceChanges.current = {
      ...pendingPreferenceChanges.current,
      ...changes,
    };
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      const pending = pendingPreferenceChanges.current;
      pendingPreferenceChanges.current = {};
      void savePetPreferences(pending);
    }, 80);
  };

  useEffect(() => {
    preferenceSaver.setActive(true);
    return () => {
      preferenceSaver.setActive(false);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      // Keep committed number-field edits when the settings panel closes.
      preferenceSaver.save(pendingPreferenceChanges.current);
      pendingPreferenceChanges.current = {};
    };
  }, [preferenceSaver]);

  const petControlsDisabled = loading || !enabled || refreshingPets;
  const selectablePets = pets.filter((pet) => pet.source !== 'remote');
  const remotePets = pets.filter((pet) => pet.source === 'remote');

  const openPetDirectory = async () => {
    setError(null);
    try {
      await bridge.openPetDirectory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开宠物素材目录失败');
    }
  };

  const openPetDocs = async () => {
    setError(null);
    try {
      window.open(CUSTOM_PET_DOCS_URL, '_blank', 'noopener,noreferrer');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '打开使用文档失败');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {(error ?? catalogError) && (
        <StatusBanner tone="error" title={error ?? catalogError ?? ''} />
      )}
      <div className="min-w-0">
        <p className="mb-3 text-sm text-muted">
          显示悬浮宠物。拖动可移动位置，右键可打开菜单。
        </p>
        <Checkbox
          id="desktop-pet-enabled"
          isDisabled={loading}
          isSelected={enabled}
          onChange={(checked) => {
            void onChange(checked);
          }}
        >
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            显示桌面宠物
          </Checkbox.Content>
        </Checkbox>
        <div className="mt-5 flex flex-col gap-5 px-4 pb-1">
          <Select
            aria-label="选择桌面宠物"
            isDisabled={petControlsDisabled}
            isOpen={petMenuOpen}
            value={selectedPetId}
            variant="secondary"
            onChange={onSelectedPetChange}
            onOpenChange={(open) => {
              if (!open && keepPetMenuOpen.current) return;
              setPetMenuOpen(open);
            }}
          >
            <Label>宠物形象</Label>
            <Select.Trigger>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <PetSelectPreview petId={selectedPetId} />
                {/* textValue only — default Value clones the whole ListBox.Item (incl. preview). */}
                <Select.Value>
                  {({ selectedText }) => selectedText}
                </Select.Value>
              </span>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover
              shouldCloseOnInteractOutside={() => !keepPetMenuOpen.current}
            >
              <ListBox aria-label="桌面宠物列表">
                {selectablePets.map((pet) => (
                  <ListBox.Item
                    id={pet.id}
                    key={pet.id}
                    textValue={pet.displayName}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <PetSelectPreview petId={pet.id} />
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span>{pet.displayName}</span>
                        <span className="text-xs text-muted">
                          {pet.description}
                        </span>
                      </div>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
                {invalidPets.map((pet) => {
                  const label = `${pet.directory} 无效：${pet.reason}`;
                  return (
                    <ListBox.Item
                      id={`invalid:${pet.directory}`}
                      isDisabled
                      key={`invalid:${pet.directory}`}
                      textValue={label}
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span>{pet.directory} 无效</span>
                        <span className="text-xs text-muted">{pet.reason}</span>
                      </div>
                    </ListBox.Item>
                  );
                })}
              </ListBox>
              {remotePets.length > 0 && (
                <div className="mt-1 border-t border-border/50 pt-1">
                  <p className="px-2 py-1 text-xs text-muted">社区宠物（下载后可选）</p>
                  {remotePets.map((pet) => {
                    const installing = installingPetId === pet.id;
                    return (
                      <div
                        className="flex items-center gap-2 px-2 py-1.5 opacity-55"
                        key={pet.id}
                      >
                        <PetSelectPreview
                          petId={pet.id}
                          spritesheetUrl={pet.previewUrl}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-sm text-muted">
                            {pet.displayName}
                          </span>
                          <span className="truncate text-xs text-muted">
                            {pet.description || '下载后即可选用'}
                          </span>
                        </div>
                        <Button
                          className="shrink-0"
                          isDisabled={installingPetId !== null || refreshingPets}
                          isPending={installing}
                          size="sm"
                          variant="secondary"
                          onPress={() => {
                            keepPetMenuOpen.current = true;
                            setPetMenuOpen(true);
                            onInstallRemotePet(pet.id);
                          }}
                          // Keep Select focus so the popover does not dismiss on press.
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                        >
                          {installing ? '下载中' : '下载'}
                        </Button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Select.Popover>
          </Select>
          <div className="flex justify-end gap-2 -mt-2">
            <Button
              isDisabled={refreshingPets}
              size="sm"
              variant="secondary"
              onPress={() => { onRefreshPets(); }}
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => { void openPetDirectory(); }}
            >
              打开宠物目录
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => { void openPetDocs(); }}
            >
              自定义指南
            </Button>
          </div>
          <Slider
            isDisabled={petControlsDisabled}
            maxValue={75}
            minValue={35}
            onChange={(value) => {
              const next = Array.isArray(value) ? (value[0] ?? scale) : value;
              editingSlider.current = true;
              preferenceSaver.invalidate();
              setScale(next);
            }}
            onChangeEnd={(value) => {
              const next = Array.isArray(value) ? (value[0] ?? scale) : value;
              editingSlider.current = false;
              savePetPreferences({ scale: next / 100 });
            }}
            step={5}
            value={scale}
          >
            <Label>宠物大小</Label>
            <Slider.Output>{`${scale}%`}</Slider.Output>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
          <Checkbox
            id="desktop-pet-auto-move-enabled"
            isDisabled={petControlsDisabled}
            isSelected={autoMoveEnabled}
            onChange={(checked) => {
              setAutoMoveEnabled(checked);
              void savePetPreferences({ autoMoveEnabled: checked });
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              自动跑动
            </Checkbox.Content>
          </Checkbox>
          <NumberField
            isDisabled={petControlsDisabled || !autoMoveEnabled}
            maxValue={120}
            minValue={1}
            onChange={(value) => {
              if (!Number.isFinite(value)) return;
              const next = Math.min(120, Math.max(1, Math.round(value)));
              setAutoMoveIntervalMinutes(next);
              schedulePetPreferenceSave({ autoMoveIntervalMinutes: next });
            }}
            step={1}
            value={autoMoveIntervalMinutes}
            variant="secondary"
          >
            <Label>跑动间隔</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>
              宠物空闲 {autoMoveIntervalMinutes} 分钟后，会在当前屏幕内随机自然跑动。
            </Description>
          </NumberField>
          <Slider
            isDisabled={petControlsDisabled}
            maxValue={320}
            minValue={120}
            onChange={(value) => {
              const next = Array.isArray(value)
                ? (value[0] ?? frameIntervalMs)
                : value;
              editingSlider.current = true;
              preferenceSaver.invalidate();
              setFrameIntervalMs(next);
            }}
            onChangeEnd={(value) => {
              const next = Array.isArray(value) ? (value[0] ?? frameIntervalMs) : value;
              editingSlider.current = false;
              savePetPreferences({ frameIntervalMs: next });
            }}
            step={10}
            value={frameIntervalMs}
          >
            <Label>动作速度</Label>
            <Slider.Output>{`${frameIntervalMs} ms / 帧`}</Slider.Output>
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
          <Checkbox
            id="desktop-pet-sync-feedback-enabled"
            isDisabled={petControlsDisabled}
            isSelected={syncFeedbackEnabled}
            onChange={(checked) => {
              setSyncFeedbackEnabled(checked);
              void savePetPreferences({ syncFeedbackEnabled: checked });
            }}
          >
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              同步后提示 Token 增量
            </Checkbox.Content>
          </Checkbox>
          <NumberField
            isDisabled={petControlsDisabled || !syncFeedbackEnabled}
            maxValue={10}
            minValue={1}
            onChange={(value) => {
              if (!Number.isFinite(value)) return;
              const next = Math.min(10, Math.max(1, Math.round(value)));
              setSyncFeedbackDurationSec(next);
              schedulePetPreferenceSave({ syncFeedbackDurationSec: next });
            }}
            step={1}
            value={syncFeedbackDurationSec}
            variant="secondary"
          >
            <Label>提示时长</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
            <Description>
              同步到新增 Token 时，气泡展示 {syncFeedbackDurationSec} 秒后自动关闭。
            </Description>
          </NumberField>
        </div>
      </div>
    </div>
  );
}
