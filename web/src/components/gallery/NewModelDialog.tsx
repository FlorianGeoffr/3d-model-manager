import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";

import { useCreateModel } from "@/api/library";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";

export function NewModelDialog({ trigger }: { trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const navigate = useNavigate();
  const createModel = useCreateModel();

  function reset() {
    setName("");
    setDescription("");
    createModel.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createModel.mutate(
      { name, description: description || undefined },
      {
        onSuccess: (model) => {
          setOpen(false);
          reset();
          void navigate({ to: "/models/$slug", params: { slug: model.slug } });
        },
      },
    );
  }

  const errorMessage =
    createModel.error instanceof ApiError
      ? createModel.error.detail
      : createModel.error
        ? "Could not create model"
        : null;

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
            <DialogTitle>New model</DialogTitle>
            <DialogDescription>Creates an empty model with an initial revision.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-model-name">Name</Label>
              <Input
                id="new-model-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-model-description">Description</Label>
              <Textarea
                id="new-model-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </div>
            {errorMessage ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="submit" disabled={createModel.isPending || name.trim().length === 0}>
              {createModel.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
