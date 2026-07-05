import { Box, FileCode2, Image as ImageIcon, type LucideIcon, File as FileIcon } from "lucide-react";

import type { BlobFormat } from "@/api/types";

/** Short display label per format (Task 8: format badges + placeholder monogram). */
export const FORMAT_LABELS: Record<BlobFormat, string> = {
  stl: "STL",
  "3mf": "3MF",
  obj: "OBJ",
  step: "STEP",
  iges: "IGES",
  gcode_3mf: "G/3MF",
  gcode: "G-code",
  png: "PNG",
  jpg: "JPG",
  other: "File",
};

/** Icon per format, used for the gallery card's placeholder thumbnail. */
export function formatIcon(format: BlobFormat | undefined): LucideIcon {
  switch (format) {
    case "stl":
    case "obj":
    case "step":
    case "iges":
    case "3mf":
      return Box;
    case "gcode":
    case "gcode_3mf":
      return FileCode2;
    case "png":
    case "jpg":
      return ImageIcon;
    default:
      return FileIcon;
  }
}
