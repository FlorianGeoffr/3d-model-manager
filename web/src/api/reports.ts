/**
 * Duplicate-files report (backend/app/schemas/reports.py, Branch 4 Task 1):
 * files sharing a blob hash across more than one model -- reclaimable
 * storage from the same content having been imported/uploaded more than once.
 */
import { useQuery } from "@tanstack/react-query";

import { api } from "@/api/client";
import type { DuplicatesReport } from "@/api/types";

export function useDuplicatesReport() {
  return useQuery({
    queryKey: ["reports", "duplicates"] as const,
    queryFn: () => api.get<DuplicatesReport>("/reports/duplicates"),
  });
}
