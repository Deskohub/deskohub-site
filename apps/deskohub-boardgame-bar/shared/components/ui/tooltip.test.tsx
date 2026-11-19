import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const renderTooltip = (props: ComponentProps<typeof Tooltip> = {}) =>
  renderToStaticMarkup(
    <Tooltip {...props}>
      <TooltipTrigger>Info</TooltipTrigger>
      <TooltipContent>Tip</TooltipContent>
    </Tooltip>
  );

const tooltipMarkup = (html: string) =>
  /<[^>]+role="tooltip"[^>]*>/.exec(html)?.[0];

describe("Tooltip", () => {
  test("the hint starts hidden unless opened by default or by its owner", () => {
    for (const props of [{}, { defaultOpen: true, open: false }]) {
      const tooltip = tooltipMarkup(renderTooltip(props));
      expect(!tooltip || /\shidden(?:=|\s|>)/.test(tooltip)).toBe(true);
    }

    for (const props of [{ defaultOpen: true }, { open: true }]) {
      const tooltip = tooltipMarkup(renderTooltip(props));
      expect(tooltip).toBeDefined();
      expect(tooltip).not.toMatch(/\shidden(?:=|\s|>)/);
    }
  });

  test("a trigger outside a tooltip is rejected", () => {
    expect(() => renderToStaticMarkup(<TooltipTrigger />)).toThrow();
  });
});
