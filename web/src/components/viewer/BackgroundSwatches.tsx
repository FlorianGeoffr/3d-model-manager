import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useRovingRadioGroup } from "@/components/viewer/useRovingRadioGroup";
import {
  BACKGROUND_PRESET_LABELS,
  BACKGROUND_PRESET_ORDER,
  resolveBackground,
  type BackgroundPreset,
} from "@/components/viewer/background";

/** A rainbow ring around the custom swatch (Task 6) so it reads as "pick any
 * color" rather than just another fixed preset -- `conic-gradient` sweeps
 * hue around the circle instead of a flat fill. */
const RAINBOW_CONIC = "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)";

const SWATCH_CLASS =
  "size-6 shrink-0 cursor-pointer rounded-full border border-border/60 outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring/50";
const SWATCH_SELECTED_CLASS = "ring-2 ring-ring";

/** `studio`/`white`/`dark`/`custom` resolve to one hex regardless of theme --
 * `resolveBackground` ignores its `isDark` argument for those, so `false` is
 * an arbitrary but harmless placeholder. `theme` is the one preset that
 * actually depends on it, so it's split into a light/dark half-and-half
 * gradient here instead of picking just one -- the swatch has to represent
 * both outcomes since it doesn't know which one is "current" the way the
 * resolved `background` prop passed to `ModelViewer` does. */
function swatchBackground(option: BackgroundPreset, custom: string): string {
  if (option === "theme") {
    const light = resolveBackground("theme", custom, false);
    const dark = resolveBackground("theme", custom, true);
    return `linear-gradient(90deg, ${light} 50%, ${dark} 50%)`;
  }
  return resolveBackground(option, custom, false);
}

/**
 * Compact replacement for the Background `SegmentedControl` (Task 6): one
 * small circular swatch per preset in `BACKGROUND_PRESET_ORDER` instead of a
 * labelled pill, so the picker takes a fraction of the width. Keyboard/ARIA
 * (roving tabindex, arrow keys, Home/End) comes from `useRovingRadioGroup` --
 * the same contract `SegmentedControl` implements, just rendered as circles.
 *
 * The `custom` swatch is special: it's simultaneously the radio option AND
 * the color-picker trigger, consolidating what used to be a "Custom" segment
 * plus a separate visible `<input type="color">` that only appeared once
 * selected (see `ViewerStage.tsx`'s prior Background block). Here the color
 * input is always present but invisible (`opacity-0`, overlaid on the
 * swatch, `aria-hidden`/`tabIndex={-1}` so it doesn't add a second stop to
 * the roving-radio tab order) -- clicking the swatch selects the custom
 * preset like any other option (via `itemProps`' `onClick`, since the click
 * bubbles up from the input through this wrapper), and changing the color
 * (via the browser's native picker) fires `onCustomChange` *and* selects
 * custom in the same step, so picking a color from an unselected swatch just
 * works without a separate click first. */
export function BackgroundSwatches({
  preset,
  custom,
  onPresetChange,
  onCustomChange,
}: {
  preset: BackgroundPreset;
  custom: string;
  onPresetChange: (preset: BackgroundPreset) => void;
  onCustomChange: (custom: string) => void;
}) {
  const { itemProps } = useRovingRadioGroup(BACKGROUND_PRESET_ORDER, preset, onPresetChange);

  return (
    // Local `TooltipProvider` (rather than relying solely on `ViewerStage`'s
    // outer one) keeps this component self-sufficient -- Radix's `Tooltip`
    // throws if it's ever rendered without a `TooltipProvider` ancestor, and
    // `BackgroundSwatches.test.tsx` renders it standalone. Nesting inside
    // `ViewerStage`'s provider is harmless -- the nearest one just wins for
    // this subtree.
    <TooltipProvider>
      <div role="radiogroup" aria-label="Background" className="flex flex-wrap items-center gap-2">
        {BACKGROUND_PRESET_ORDER.map((option) => {
          const selected = preset === option;
          const label = BACKGROUND_PRESET_LABELS[option];

          if (option === "custom") {
            return (
              <Tooltip key={option}>
                <TooltipTrigger asChild>
                  <span
                    {...itemProps(option)}
                    aria-label={label}
                    className={cn(SWATCH_CLASS, "relative inline-flex", selected && SWATCH_SELECTED_CLASS)}
                    style={{ background: RAINBOW_CONIC }}
                  >
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-[3px] rounded-full"
                      style={{ background: resolveBackground("custom", custom, false) }}
                    />
                    <input
                      type="color"
                      aria-hidden="true"
                      tabIndex={-1}
                      value={custom}
                      onChange={(event) => {
                        onCustomChange(event.target.value);
                        onPresetChange("custom");
                      }}
                      className="absolute inset-0 size-full cursor-pointer opacity-0"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            );
          }

          return (
            <Tooltip key={option}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={label}
                  {...itemProps(option)}
                  className={cn(SWATCH_CLASS, selected && SWATCH_SELECTED_CLASS)}
                  style={{ background: swatchBackground(option, custom) }}
                />
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}
