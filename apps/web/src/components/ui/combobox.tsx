import { Combobox as Primitive } from '@base-ui/react/combobox';
import { IconCheck } from '@tabler/icons-react';
import { cn } from '@web/lib/utils';

export const Combobox = Primitive.Root;
export const ComboboxTrigger = Primitive.Trigger;
export const ComboboxInput = Primitive.Input;

export function ComboboxContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  ...props
}: Primitive.Popup.Props &
  Pick<
    Primitive.Positioner.Props,
    "side" | "align" | "sideOffset" | "alignOffset" | "anchor"
  >) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        className="isolate z-110"
      >
        <Primitive.Popup
          data-slot="combobox-content"
          data-chips={!!anchor}
          className={cn(
            "web-overlay-motion cn-menu-target cn-menu-translucent group/combobox-content relative max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-[calc(var(--anchor-width)+--spacing(7))] origin-(--transform-origin) overflow-hidden rounded-md bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 data-[chips=true]:min-w-(--anchor-width) *:data-[slot=input-group]:m-1 *:data-[slot=input-group]:mb-0 *:data-[slot=input-group]:h-8 *:data-[slot=input-group]:border-input/30 *:data-[slot=input-group]:bg-input/30 *:data-[slot=input-group]:shadow-none",
            className
          )}
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  )
}

export function ComboboxList({ className, ...props }: Primitive.List.Props) {
  return (
    <Primitive.List
      data-slot="combobox-list"
      className={cn(
        "max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] scroll-py-1 overflow-y-auto overscroll-contain p-1 data-empty:p-0",
        className
      )}
      {...props}
    />
  )
}

export function ComboboxItem({
  className,
  children,
  showIndicator = true,
  ...props
}: Primitive.Item.Props & { showIndicator?: boolean }) {
  return (
    <Primitive.Item
      data-slot="combobox-item"
      className={cn(
        "relative flex w-full cursor-pointer items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none data-highlighted:bg-secondary data-highlighted:text-secondary-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
    >
      {children}
      {showIndicator && <Primitive.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center" />
        }
      >
        <IconCheck aria-hidden="true" className="size-4" />
      </Primitive.ItemIndicator>}
    </Primitive.Item>
  )
}

export function ComboboxEmpty({ className, ...props }: Primitive.Empty.Props) {
  return (
    <Primitive.Empty
      data-slot="combobox-empty"
      className={cn(
        "hidden w-full justify-center py-2 text-center text-sm text-muted-foreground group-data-empty/combobox-content:flex",
        className
      )}
      {...props}
    />
  )
}
