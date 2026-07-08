import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { TargetPicker } from "@/components/upload/TargetPicker";

// The "existing model" search calls useModelSearchQuery (the results list) and
// modelQueryOptions (to resolve the picked model's current revision). Mock both
// so the picker runs network-free.
vi.mock("@/api/library", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/library")>();
  return {
    ...actual,
    useModelSearchQuery: () => ({
      data: {
        items: [
          { id: 1, slug: "model-a", name: "Model A" },
          { id: 2, slug: "model-b", name: "Model B" },
        ],
      },
    }),
    modelQueryOptions: (slug: string) => ({
      queryKey: ["test-model-detail", slug],
      queryFn: async () => ({
        id: slug === "model-b" ? 2 : 1,
        slug,
        name: slug === "model-b" ? "Model B" : "Model A",
        current_revision: { id: slug === "model-b" ? 20 : 10 },
      }),
    }),
  };
});

function renderPicker(props: Partial<ComponentProps<typeof TargetPicker>> = {}) {
  const onExistingTargetChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <TargetPicker
        mode="existing"
        onModeChange={() => {}}
        newModelName=""
        onNewModelNameChange={() => {}}
        existingTarget={null}
        onExistingTargetChange={onExistingTargetChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onExistingTargetChange };
}

describe("TargetPicker existing-model search", () => {
  it("accepts typed input and keeps the full string in the search field", () => {
    renderPicker();
    const input = screen.getByLabelText("Model") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "drag" } });
    expect(input.value).toBe("drag");
    // The regression this fixes: the field lost focus after the first
    // keystroke, so later characters were dropped. They must accumulate.
    fireEvent.change(input, { target: { value: "dragon" } });
    expect(input.value).toBe("dragon");
  });

  it("shows results while typing and resolves the picked model on select", async () => {
    const { onExistingTargetChange } = renderPicker();

    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "Model" } });
    fireEvent.click(await screen.findByRole("button", { name: "Model B" }));

    await waitFor(() =>
      expect(onExistingTargetChange).toHaveBeenCalledWith({
        modelId: 2,
        revisionId: 20,
        slug: "model-b",
        name: "Model B",
      }),
    );
  });

  it("does not render the results dropdown before the user starts typing", () => {
    renderPicker();
    expect(screen.queryByRole("button", { name: "Model A" })).not.toBeInTheDocument();
  });
});
