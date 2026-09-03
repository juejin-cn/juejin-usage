import { Button, Checkbox, Modal } from '@heroui/react';
import { useEffect, useState } from 'react';

export const JUEJIN_PRIVACY_POLICY_URL =
  'https://lf3-cdn-tos.draftstatic.com/obj/ies-hotsoon-draft/juejin/7b28b328-1ae4-4781-8d46-430fef1b872e.html';

async function openPrivacyPolicy(): Promise<void> {
  const openExternal = (
    window as {
      tud?: {
        openExternal?: (href: string) => Promise<{ ok: boolean }>;
      };
    }
  ).tud?.openExternal;

  if (typeof openExternal === 'function') {
    await openExternal(JUEJIN_PRIVACY_POLICY_URL);
    return;
  }

  window.open(JUEJIN_PRIVACY_POLICY_URL, '_blank', 'noopener,noreferrer');
}

export function JuejinLoginConsentModal({
  isOpen,
  onOpenChange,
  onConfirm,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    if (isOpen) setAgreed(false);
  }, [isOpen]);

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={onOpenChange} variant="opaque">
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.CloseTrigger aria-label="关闭" />
          <Modal.Header>
            <Modal.Heading>用户协议</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4 text-sm leading-6 text-muted">
            <p>
              关联掘金账号后，本机用量数据将在您开启云端同步时上传至掘金服务。请先阅读并同意相关协议。
            </p>
            <Checkbox
              id="juejin-login-consent"
              isSelected={agreed}
              onChange={setAgreed}
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span>
                  我已阅读并同意
                  <button
                    className="mx-0.5 text-accent underline underline-offset-2 hover:opacity-80"
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      void openPrivacyPolicy();
                    }}
                    type="button"
                  >
                    《稀土掘金隐私政策》
                  </button>
                  ，并同意上传数据
                </span>
              </Checkbox.Content>
            </Checkbox>
          </Modal.Body>
          <Modal.Footer className="gap-2">
            <Button slot="close" variant="tertiary">
              取消
            </Button>
            <Button
              isDisabled={!agreed}
              onPress={() => {
                onOpenChange(false);
                onConfirm();
              }}
              variant="primary"
            >
              同意并登录
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
