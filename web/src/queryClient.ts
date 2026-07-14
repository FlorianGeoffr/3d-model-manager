import { MutationCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/api/client";

export const queryClient = new QueryClient({
  // Global fallback so actions without their own inline error UI (archive,
  // delete file, tag add/remove, notes) still surface failures instead of
  // failing silently. Forms with inline error text (login, new
  // model/revision dialogs) get a toast too, which is a harmless bonus.
  //
  // `meta.silentError` opts a mutation out: a caller that fans the SAME
  // mutation out over a selection (the library's bulk "Add to queue" loop)
  // reports one summary toast itself, and would otherwise stack a
  // per-failure toast on top of it for every model in the batch.
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silentError) return;
      toast.error(error instanceof ApiError ? error.detail : "Something went wrong");
    },
  }),
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
