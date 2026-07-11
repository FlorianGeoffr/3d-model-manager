import { useRef, type KeyboardEvent } from "react";

/**
 * The ARIA APG radiogroup keyboard contract, as a generic hook -- extracted
 * from `SegmentedControl` (Task 6) so `BackgroundSwatches` can drive the same
 * roving-tabindex behavior over a different visual (circular swatches
 * instead of labelled segments) without duplicating the arrow-key logic.
 * `SegmentedControl` is now a thin renderer over this hook, with ZERO
 * behavior change -- `SegmentedControl.test.tsx` exercises this contract
 * unmodified.
 *
 * Roving tabindex: the group is a single tab stop (only the selected item
 * has `tabIndex={0}`), and arrow keys both move focus *and* change the
 * selection -- Left/Up to the previous option, Right/Down to the next, both
 * wrapping around `options`, plus Home/End for the first and last. Callers
 * spread `itemProps(option)` onto whichever element renders that option
 * (a `<button>`, or something else entirely, e.g. the label wrapping
 * `BackgroundSwatches`' custom-color swatch) -- the returned `ref` is typed
 * `HTMLElement | null` so it's assignable to any element's ref regardless of
 * its concrete tag.
 */
export function useRovingRadioGroup<T extends string>(
  options: readonly T[],
  value: T,
  onChange: (next: T) => void,
): {
  itemProps: (option: T) => {
    role: "radio";
    "aria-checked": boolean;
    tabIndex: number;
    ref: (el: HTMLElement | null) => void;
    onClick: () => void;
    onKeyDown: (e: KeyboardEvent) => void;
  };
} {
  const itemRefs = useRef<(HTMLElement | null)[]>([]);

  function moveTo(index: number) {
    onChange(options[index]);
    itemRefs.current[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent, index: number) {
    const last = options.length - 1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveTo(index === last ? 0 : index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveTo(index === 0 ? last : index - 1);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(last);
        break;
      default:
        break;
    }
  }

  function itemProps(option: T) {
    const index = options.indexOf(option);
    const selected = value === option;
    return {
      role: "radio" as const,
      "aria-checked": selected,
      tabIndex: selected ? 0 : -1,
      ref: (el: HTMLElement | null) => {
        itemRefs.current[index] = el;
      },
      onClick: () => onChange(option),
      onKeyDown: (event: KeyboardEvent) => handleKeyDown(event, index),
    };
  }

  return { itemProps };
}
