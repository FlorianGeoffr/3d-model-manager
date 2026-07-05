import { MutationCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "@/api/client";

export const queryClient = new QueryClient({
  // Global fallback so actions without their own inline error UI (archive,
  // delete file, tag add/remove, notes) still surface failures instead of
  // failing silently. Forms with inline error text (login, new
  // model/revision dialogs) get a toast too, which is a harmless bonus.
  mutationCache: new MutationCache({
    onError: (error) => {
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
