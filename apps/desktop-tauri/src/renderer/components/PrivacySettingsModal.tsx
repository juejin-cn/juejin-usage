import { Lock, ShieldCheck } from '@gravity-ui/icons';
import { Button, Modal } from '@heroui/react';
import { useState } from 'react';

export function PrivacySettingsModal() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button onPress={() => setIsOpen(true)} variant="tertiary">
        <Lock />
        隐私设置
      </Button>

      <Modal.Backdrop
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        variant="blur"
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger aria-label="关闭隐私说明" />
            <Modal.Header>
              <Modal.Icon className="bg-success-soft text-success-soft-foreground">
                <ShieldCheck />
              </Modal.Icon>
              <Modal.Heading>排行榜隐私说明</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-3 text-sm leading-6 text-muted">
              <p>
                排行榜仅展示匿名昵称、Token 用量和预估消费，用于社区用量对比。
              </p>
              <p>
                项目名、设备名、账号标识、鉴权信息及对话内容不会出现在排行榜中。
              </p>
              <p>
                可在排行榜页的「隐藏自己」开关中选择是否参与公开排名。
              </p>
            </Modal.Body>
            <Modal.Footer>
              <Button slot="close">我知道了</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
