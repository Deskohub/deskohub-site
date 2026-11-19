"use client";

import {
  Tooltip,
  TooltipContent as TooltipPrimitiveContent,
  TooltipTrigger,
} from "@ui-sdk/react/tooltip";
import type { ComponentProps } from "react";
import { cn } from "@/shared/utils/index";

function TooltipContent({
  className,
  ...props
}: ComponentProps<typeof TooltipPrimitiveContent>) {
  return (
    <TooltipPrimitiveContent
      className={cn(
        "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--transform-origin]",
        className
      )}
      {...props}
    />
  );
}

export { Tooltip, TooltipContent, TooltipTrigger };
