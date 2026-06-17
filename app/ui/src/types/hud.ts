export type HudComponentConfig = {
  type: "panel" | "overlay" | "indicator";
  draggable: boolean;
  resizable: boolean;
};

export type HudComponentState = {
  id: string;
  name: string;
  status: string;
  visible?: boolean;
  /** Ephemeral panels don't persist layout/visibility to settings */
  ephemeral?: boolean;
  hudConfig: HudComponentConfig;
  position: { x: number; y: number };
  size: { width: number; height: number };
  data: Record<string, unknown>;
  renderer?: { plugin: string; file: string };
  /** Per-panel monotonic revision stamped by the backend (F6 hud-truth).
   *  Absent on older servers — gap detection is skipped then. */
  rev?: number;
  /** Epoch ms of the last REAL content change (F6 staleness). */
  updatedAt?: number;
};

export type HudReactor = {
  status: string;
  coreLabel: string;
  coreSubLabel: string;
};

export type HudState = {
  reactor: HudReactor;
  components: HudComponentState[];
};

export type HudNode = {
  id: string;
  label: string;
  value: string;
  color: string;
  pulse?: boolean;
  expanded?: boolean;
  children?: HudNode[];
};
