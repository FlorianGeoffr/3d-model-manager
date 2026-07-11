import { useRef, type KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

/** Compact segmented control for a small fixed set of options -- used for
 * both the viewer's Background and Lighting pickers, which replaced
 * dropdown `<Select>`s so a choice takes one click instead of two, and so
 * they can be driven under jsdom without mocking a Radix floating-UI open
 * state (see the inline mock comment in `ViewerTab.test.tsx`). A plain
 * `role="radiogroup"` of `role="radio"` buttons rather than the shadcn
 * `RadioGroup` primitive, which renders radio dots, not labelled segments.
 *
 * Implements the ARIA APG radiogroup keyboard contract via roving tabindex:
 * the group is a single tab stop (only the selected segment has
 * `tabIndex={0}`), and arrow keys both move focus *and* change the
 * selection -- Left/Up to the previous option, Right/Down to the next, both
 * wrapping around `options`, plus Home/End for the first and last. Without
 * this the control announces itself as a radiogroup but behaves like a plain
 * button toolbar, which is worse than the `<Select>` it replaced. */
export function SegmentedControl<T extends string>({
  label,
  options,
  labels,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  onChange: (next: T) => void;
  className?: string;
}) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function moveTo(index: number) {
    onChange(options[index]);
    buttonRefs.current[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
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

  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-0.5 rounded-md bg-muted p-0.5", className)}>
      {options.map((option, index) => {
        const selected = value === option;
        return (
          <button
            key={option}
            ref={(el) => {
              buttonRefs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={cn(
              "h-7 rounded-sm px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50",
              selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {labels[option]}
          </button>
        );
      })}
    </div>
  );
}
