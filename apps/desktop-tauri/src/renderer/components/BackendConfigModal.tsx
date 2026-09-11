import { Gear } from "@gravity-ui/icons";
import { Button, Modal } from "@heroui/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import { SettingsPanel } from "@/components/SettingsPanel";
import {
  OPEN_SETTINGS_EVENT,
  type OpenSettingsDetail,
  type SettingsTabId,
} from "@/lib/shell-events";

interface BackendConfigModalProps {
  /** Custom trigger; when omitted and uncontrolled, renders a default tertiary button. */
  trigger?: ReactNode;
  /** Controlled open state. */
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Listen for `tud:open-settings` to open (default true when uncontrolled or when shell mounts). */
  listenForOpenEvent?: boolean;
  /** Hide the default trigger (shell-owned modal with event / external open only). */
  hideTrigger?: boolean;
  /** Controlled settings tab (e.g. deep-link opens「云端同步」). */
  activeTab?: SettingsTabId;
  onTabChange?: (tab: SettingsTabId) => void;
}

/** Backend configuration trigger and controlled modal. */
export function BackendConfigModal({
  trigger,
  isOpen: controlledOpen,
  onOpenChange,
  listenForOpenEvent = true,
  hideTrigger = false,
  activeTab: controlledTab,
  onTabChange,
}: BackendConfigModalProps = {}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [uncontrolledTab, setUncontrolledTab] = useState<SettingsTabId>("pet");
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;
  const activeTab = controlledTab ?? uncontrolledTab;

  const setOpen = useCallback(
    (open: boolean) => {
      if (!isControlled) setUncontrolledOpen(open);
      onOpenChange?.(open);
    },
    [isControlled, onOpenChange],
  );

  const setTab = useCallback(
    (tab: SettingsTabId) => {
      if (controlledTab === undefined) setUncontrolledTab(tab);
      onTabChange?.(tab);
    },
    [controlledTab, onTabChange],
  );

  useEffect(() => {
    if (!listenForOpenEvent) return;
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenSettingsDetail>).detail;
      if (detail?.tab) setTab(detail.tab);
      setOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
  }, [listenForOpenEvent, setOpen, setTab]);

  return (
    <>
      {!hideTrigger &&
        (trigger ?? (
          <Button
            aria-label="设置"
            onPress={() => setOpen(true)}
            variant="tertiary"
          >
            <Gear />
            设置
          </Button>
        ))}

      <Modal.Backdrop
        isOpen={isOpen}
        onOpenChange={setOpen}
        variant="opaque"
      >
        <Modal.Container
          className="w-full max-w-[720px] sm:w-[720px]"
          scroll="inside"
          size="lg"
        >
          <Modal.Dialog
            aria-label="设置"
            className="w-full overflow-hidden sm:w-[640px] sm:max-w-[640px]"
          >
            <Modal.CloseTrigger aria-label="关闭设置" />
            <Modal.Header>
              <Modal.Heading>设置</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="overflow-hidden p-0">
              <SettingsPanel activeTab={activeTab} onTabChange={setTab} />
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
