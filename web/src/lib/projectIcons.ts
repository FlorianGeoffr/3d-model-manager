import type { ComponentType } from "react";
import {
  Bot,
  Box,
  Car,
  Cog,
  Cpu,
  Folder,
  Gamepad2,
  Heart,
  Home,
  Palette,
  Puzzle,
  Rocket,
  Shield,
  Wrench,
} from "lucide-react";

export interface ProjectIconOption {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const PROJECT_ICONS: ProjectIconOption[] = [
  { id: "folder", label: "Dossier", icon: Folder },
  { id: "cog", label: "Mécanique", icon: Cog },
  { id: "wrench", label: "Outil", icon: Wrench },
  { id: "gamepad", label: "Jeu / Figurine", icon: Gamepad2 },
  { id: "home", label: "Maison", icon: Home },
  { id: "rocket", label: "Aéro / Spatial", icon: Rocket },
  { id: "box", label: "Boîte / Rangement", icon: Box },
  { id: "bot", label: "Robotique", icon: Bot },
  { id: "car", label: "Véhicule", icon: Car },
  { id: "palette", label: "Art / Déco", icon: Palette },
  { id: "puzzle", label: "Puzzle", icon: Puzzle },
  { id: "heart", label: "Coup de cœur", icon: Heart },
  { id: "shield", label: "Protection", icon: Shield },
  { id: "cpu", label: "Électronique", icon: Cpu },
];

const ICON_MAP = new Map<string, ComponentType<{ className?: string }>>(
  PROJECT_ICONS.map((item) => [item.id, item.icon]),
);

export function getProjectIcon(id: string | null | undefined): ComponentType<{ className?: string }> {
  if (!id) return Folder;
  return ICON_MAP.get(id) ?? Folder;
}
