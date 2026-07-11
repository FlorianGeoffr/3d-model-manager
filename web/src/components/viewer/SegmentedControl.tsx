import { cn } from "@/lib/utils";
import { useRovingRadioGroup } from "@/components/viewer/useRovingRadioGroup";

/** Compact segmented control for a small fixed set of options -- used for
 * both the viewer's Background and Lighting pickers, which replaced
 * dropdown `<Select>`s so a choice takes one click instead of two, and so
 * they can be driven under jsdom without mocking a Radix floating-UI open
 * state (see the inline mock comment in `ViewerTab.test.tsx`). A plain
 * `role="radiogroup"` of `role="radio"` buttons rather than the shadcn
 * `RadioGroup` primitive, which renders radio dots, not labelled segments.
 *
 * The roving-tabindex/arrow-key contract itself lives in
 * `useRovingRadioGroup` (Task 6) -- this component is just the labelled-pill
 * rendering over it, so `BackgroundSwatches`' circular swatches can share the
 * exact same keyboard behavior without a copy of this logic. */
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
  const { itemProps } = useRovingRadioGroup(options, value, onChange);

  return (
    <div role="radiogroup" aria-label={label} className={cn("flex items-center gap-0.5 rounded-md bg-muted p-0.5", className)}>
      {options.map((option) => {
        const selected = value === option;
        return (
          <button
            key={option}
            type="button"
            {...itemProps(option)}
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
