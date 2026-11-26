import { useEffect, useState } from 'react';
import { OPEN_SHARE_EVENT } from '@/lib/shell-events';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { UsageReceipt } from './UsageReceipt';

export function UsageReceiptModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handleOpen = () => setOpen(true);
    window.addEventListener(OPEN_SHARE_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_SHARE_EVENT, handleOpen);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100%-1.5rem)] gap-0 overflow-hidden p-0 sm:max-w-[440px] md:max-w-[740px]">
        <DialogTitle className="sr-only">掘金用量小票</DialogTitle>
        {open && <UsageReceipt />}
      </DialogContent>
    </Dialog>
  );
}
