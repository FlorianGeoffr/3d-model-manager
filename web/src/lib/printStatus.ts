import type { PrintStatus } from "@/api/types";

export interface PrintStatusMeta {
  status: PrintStatus;
  label: string;
  badgeClass: string;
  dotClass: string;
}

export const PRINT_STATUS_CONFIG: Record<PrintStatus, PrintStatusMeta> = {
  idle: {
    status: "idle",
    label: "Non défini",
    badgeClass: "bg-muted text-muted-foreground border-border",
    dotClass: "bg-muted-foreground",
  },
  to_print: {
    status: "to_print",
    label: "À imprimer",
    badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
    dotClass: "bg-amber-500",
  },
  printing: {
    status: "printing",
    label: "En cours",
    badgeClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 animate-pulse",
    dotClass: "bg-blue-500",
  },
  printed: {
    status: "printed",
    label: "Imprimé",
    badgeClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    dotClass: "bg-emerald-500",
  },
  finishing: {
    status: "finishing",
    label: "Finition",
    badgeClass: "bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30",
    dotClass: "bg-purple-500",
  },
  failed: {
    status: "failed",
    label: "Échoué",
    badgeClass: "bg-destructive/10 text-destructive border-destructive/30",
    dotClass: "bg-destructive",
  },
};

export const ALL_PRINT_STATUSES: PrintStatus[] = [
  "to_print",
  "printing",
  "printed",
  "finishing",
  "failed",
  "idle",
];

export function getPrintStatusMeta(status: PrintStatus | string | null | undefined): PrintStatusMeta {
  if (status && status in PRINT_STATUS_CONFIG) {
    return PRINT_STATUS_CONFIG[status as PrintStatus];
  }
  return PRINT_STATUS_CONFIG.idle;
}
