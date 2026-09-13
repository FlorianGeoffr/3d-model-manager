/**
 * Categories CRUD (R13b, Settings -> General): name + a free-form color
 * swatch, mirroring `StorageBackendsCard`'s add/edit-dialog + table-row
 * conventions. Unlike tags (`TagEditor`'s fixed 10-key `TAG_COLORS`
 * palette), a category's `color` is a plain string the backend doesn't
 * constrain -- edited here as a native `<input type="color">` swatch, same
 * "pick a color" affordance without inventing a second fixed palette.
 */
import { useState, type FormEvent } from "react";

import { useCategories, useCreateCategory, useDeleteCategory, useUpdateCategory } from "@/api/categories";
import { ApiError } from "@/api/client";
import type { CategoryOut } from "@/api/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const DEFAULT_COLOR = "#64748b"; // slate-500 -- a neutral starting swatch

function CategoryFormDialog({ trigger, category }: { trigger: React.ReactNode; category?: CategoryOut }) {
  const isEdit = category !== undefined;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(category?.name ?? "");
  const [color, setColor] = useState(category?.color ?? DEFAULT_COLOR);

  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const mutation = isEdit ? updateCategory : createCategory;

  function reset() {
    setName(category?.name ?? "");
    setColor(category?.color ?? DEFAULT_COLOR);
    createCategory.reset();
    updateCategory.reset();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isEdit) {
      updateCategory.mutate({ id: category.id, payload: { name: trimmed, color } }, { onSuccess: () => setOpen(false) });
    } else {
      createCategory.mutate({ name: trimmed, color }, { onSuccess: () => setOpen(false) });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEdit ? `Edit "${category.name}"` : "Add category"}</DialogTitle>
            <DialogDescription>
              A model has at most one category -- a coarser grouping than tags.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category-name">Name</Label>
              <Input
                id="category-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={mutation.isPending}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="category-color">Color</Label>
              <input
                id="category-color"
                type="color"
                value={color}
                onChange={(event) => setColor(event.target.value)}
                disabled={mutation.isPending}
                className="h-9 w-16 cursor-pointer rounded border border-input bg-transparent p-1"
              />
            </div>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {mutation.error instanceof ApiError ? mutation.error.detail : "Could not save this category"}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={name.trim().length === 0 || mutation.isPending}>
              {mutation.isPending ? "Saving..." : isEdit ? "Save changes" : "Add category"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CategoryRow({ category }: { category: CategoryOut }) {
  const deleteCategory = useDeleteCategory();
  const deletingThis = deleteCategory.isPending && deleteCategory.variables === category.id;
  const deleteErrorForThis = deleteCategory.isError && deleteCategory.variables === category.id;

  return (
    <TableRow>
      <TableCell>
        <span
          aria-hidden="true"
          className="inline-block size-3 rounded-full align-middle"
          style={{ backgroundColor: category.color ?? undefined }}
        />
      </TableCell>
      <TableCell className="font-medium text-foreground">{category.name}</TableCell>
      <TableCell className="text-muted-foreground">{category.model_count}</TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex flex-wrap items-center gap-1.5">
          <CategoryFormDialog
            category={category}
            trigger={
              <Button type="button" size="sm" variant="outline">
                Edit
              </Button>
            }
          />
          <ConfirmDialog
            trigger={
              <Button type="button" size="sm" variant="destructive" disabled={deletingThis}>
                {deletingThis ? "Deleting..." : "Delete"}
              </Button>
            }
            title={`Delete "${category.name}"?`}
            description={
              category.model_count > 0
                ? `${category.model_count} model${category.model_count === 1 ? "" : "s"} will become uncategorized.`
                : "This category has no models on it."
            }
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteCategory.mutate(category.id)}
          />
        </div>
        {deleteErrorForThis ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {deleteCategory.error instanceof ApiError ? deleteCategory.error.detail : "Could not delete this category"}
          </p>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

export function CategoriesSection() {
  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        <CardDescription>
          Exclusive, single-per-model groupings (unlike tags, which can be many-per-model).
        </CardDescription>
        <CardAction>
          <CategoryFormDialog
            trigger={
              <Button type="button" variant="outline">
                Add category
              </Button>
            }
          />
        </CardAction>
      </CardHeader>
      <CardContent>
        {categoriesQuery.isLoading ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : categoriesQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {categoriesQuery.error instanceof ApiError ? categoriesQuery.error.detail : "Could not load categories"}
          </p>
        ) : categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">No categories yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Name</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <CategoryRow key={category.id} category={category} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
