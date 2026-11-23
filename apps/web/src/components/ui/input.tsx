import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@web/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 rounded-md border border-border bg-transparent px-3 text-sm focus-visible:ring-2 focus-visible:ring-accent w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Input }
