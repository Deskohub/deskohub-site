"use client";

import { sourceOf } from "@ui-sdk/core";
import {
  createTooltipController,
  TooltipContent,
  Tooltip as TooltipPrimitive,
  type TooltipProps,
  TooltipTrigger,
} from "@ui-sdk/react/tooltip";
import {
  type ComponentProps,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "@/shared/utils/index";

type Props = Pick<
  TooltipProps,
  "children" | "defaultOpen" | "delay" | "onOpenChange" | "open"
> & {
  trigger: ReactElement<ComponentProps<"button">, "button">;
  contentClassName?: string;
};

export function Tooltip({
  children,
  contentClassName,
  delay = 200,
  trigger,
  ...props
}: Props) {
  const [controller] = useState(createTooltipController);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const button = triggerRef.current;
    if (!button) return;

    const document = button.ownerDocument;
    function dismissOnScroll(event: Event) {
      if (event.target instanceof Node && event.target.contains(button)) {
        controller.close();
      }
    }

    const dismissOnOutsideTouch = (event: PointerEvent) => {
      if (
        event.pointerType === "touch" &&
        event.target instanceof Node &&
        !button.contains(event.target) &&
        !contentRef.current?.contains(event.target)
      ) {
        controller.close({ reason: "outside-press", event });
      }
    };

    const cleanup = new AbortController();
    const options = { capture: true, passive: true, signal: cleanup.signal };
    document.addEventListener("scroll", dismissOnScroll, options);
    // WebKit may omit the click the SDK waits for on non-interactive targets.
    document.addEventListener("pointerup", dismissOnOutsideTouch, options);
    return () => cleanup.abort();
  }, [controller]);

  return (
    <TooltipPrimitive
      {...props}
      controller={controller}
      delay={delay}
      type="description"
    >
      <TooltipTrigger
        ref={triggerRef}
        render={trigger}
        onClick={(event) => {
          if (sourceOf(event.nativeEvent) !== "touch") return;

          // Let the SDK handle other presses, including clearing pending hover.
          event.preventDefault();
          controller.toggle({
            reason: "trigger-press",
            event: event.nativeEvent,
          });
        }}
      />
      <TooltipContent
        ref={contentRef}
        className={cn(
          "z-50 overflow-hidden rounded-md border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-[--transform-origin]",
          contentClassName
        )}
      >
        {children}
      </TooltipContent>
    </TooltipPrimitive>
  );
}
