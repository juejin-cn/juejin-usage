import { Modal } from '@heroui/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useJuejinAuth } from '@/hooks/JuejinAuthContext';
import { useShareSnapshot } from '@/hooks/ShareSnapshotContext';
import { OPEN_SHARE_EVENT } from '@/lib/shell-events';
import {
  getShareCardVariant,
  ShareCardCarousel,
} from './ShareCardCarousel';
import { ShareCardActions } from './ShareCardActions';

/** Share-card preview backed by the current dashboard snapshot. */
export function ShareActivityModal({ receipt }: { receipt?: ReactNode } = {}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const { avatarLarge, userName } = useJuejinAuth();
  const { snapshot } = useShareSnapshot();

  useEffect(() => {
    const open = () => {
      setIsOpen(true);
    };
    window.addEventListener(OPEN_SHARE_EVENT, open);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, open);
  }, []);

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={setIsOpen}>
      <Modal.Container scroll="inside" size="lg">
        <Modal.Dialog
          aria-label="分享"
          className={`overflow-hidden ${receipt ? 'sm:max-w-[480px]' : 'sm:max-w-[760px]'}`}
        >
          <Modal.CloseTrigger aria-label="关闭分享" />
          <Modal.Body className="px-4 pb-4 pt-8 sm:px-8">
            {receipt ? receipt : <ShareCardCarousel
              activeIndex={activeIndex}
              avatarUrl={avatarLarge}
              onActiveIndexChange={setActiveIndex}
              rangeLabel={snapshot?.rangeLabel}
              summary={snapshot?.summary ?? null}
              toolLabel={snapshot?.toolLabel}
              userName={userName}
            />}
          </Modal.Body>
          {!receipt && <Modal.Footer className="justify-center">
            <ShareCardActions
              avatarUrl={avatarLarge}
              color={getShareCardVariant(activeIndex).color}
              petId={getShareCardVariant(activeIndex).petId}
              rangeLabel={snapshot?.rangeLabel}
              summary={snapshot?.summary ?? null}
              toolLabel={snapshot?.toolLabel}
              userName={userName}
            />
          </Modal.Footer>}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
