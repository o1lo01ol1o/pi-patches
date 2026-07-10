import { truncateToWidth, visibleWidth as tuiVisibleWidth } from "@earendil-works/pi-tui";

export type BgFn = (text: string) => string;
export type ColorDepth = "ansi256" | "truecolor";
export type TintTheme = "dark" | "light";

type Rgb = readonly [number, number, number];

const ansiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

const tintPalette = {
  dark: {
    add: { old: [0x1c, 0x2e, 0x1c], recent: [0x14, 0x52, 0x14] },
    del: { old: [0x33, 0x1f, 0x24], recent: [0x67, 0x16, 0x1f] }
  },
  light: {
    add: { old: [0xe6, 0xf7, 0xe6], recent: [0x7d, 0xdc, 0x7d] },
    del: { old: [0xfd, 0xee, 0xf0], recent: [0xf5, 0x91, 0x9e] }
  }
} as const;

const xtermLevels = [0, 95, 135, 175, 215, 255] as const;

export function applyBackgroundToLine(line: string, width: number, bg: BgFn): string {
  const visible = visibleWidth(line);
  const padding = visible < width ? " ".repeat(width - visible) : "";
  return bg(`${line}${padding}`);
}

export function stripAnsi(input: string): string {
  return input.replace(ansiPattern, "");
}

export function visibleWidth(input: string): number {
  return tuiVisibleWidth(input);
}

export function truncateVisible(input: string, width: number): string {
  return truncateToWidth(input, width, "");
}

export const tint = {
  added: (text: string) => `\x1b[48;5;22m${text}\x1b[49m`,
  removed: (text: string) => `\x1b[48;5;52m${text}\x1b[49m`
} as const;

export function selectionTint(depth: ColorDepth, theme: TintTheme): BgFn {
  const rgb: Rgb = theme === "dark" ? [0x3a, 0x3a, 0x4a] : [0xd0, 0xd0, 0xe0];
  return depth === "truecolor" ? bgTruecolor(rgb) : bgAnsi256(rgbToAnsi256(rgb));
}

export function diffGutter(kind: "add" | "del" | "context", text: string): string {
  const color = kind === "add" ? 32 : kind === "del" ? 31 : 90;
  return `\x1b[${color}m${text}\x1b[39m`;
}

export function changeTint(
  kind: "add" | "del",
  rank: number,
  mode: "gradient" | "uniform" | "off",
  depth: ColorDepth,
  theme: TintTheme
): BgFn | null {
  return changeTintWithDepth(kind, rank, mode, depth, theme);
}

export function changeTintWithDepth(
  kind: "add" | "del",
  rank: number,
  mode: "gradient" | "uniform" | "off",
  depth: ColorDepth,
  theme: TintTheme = "dark"
): BgFn | null {
  if (mode === "off") return null;
  const clamped = Math.max(0, Math.min(1, rank));
  const palette = tintPalette[theme][kind];
  const rgb = lerpRgb(palette.old, palette.recent, mode === "uniform" ? 1 : clamped);
  return depth === "truecolor" ? bgTruecolor(rgb) : bgAnsi256(rgbToAnsi256(rgb));
}

export function detectColorDepth(env: Record<string, string | undefined>): ColorDepth {
  const colorTerm = env.COLORTERM?.toLowerCase() ?? "";
  const term = env.TERM?.toLowerCase() ?? "";
  if (colorTerm.includes("truecolor") || colorTerm.includes("24bit")) return "truecolor";
  if (term.includes("truecolor") || term.includes("24bit")) return "truecolor";
  if (env.KITTY_WINDOW_ID !== undefined || term.includes("kitty")) return "truecolor";
  if (env.TERM_PROGRAM === "iTerm.app" || env.TERM_PROGRAM === "WezTerm") return "truecolor";
  return "ansi256";
}

export function detectTintTheme(env: Record<string, string | undefined>): TintTheme {
  const forced = env.PI_PATCHES_TINT_THEME?.toLowerCase();
  if (forced === "light" || forced === "dark") return forced;

  const namedBackground =
    env.TERM_BACKGROUND?.toLowerCase() ??
    env.BACKGROUND?.toLowerCase() ??
    env.COLOR_SCHEME?.toLowerCase();
  if (namedBackground?.includes("light")) return "light";
  if (namedBackground?.includes("dark")) return "dark";

  const colorFgBg = env.COLORFGBG;
  if (colorFgBg) {
    const background = Number(colorFgBg.split(";").at(-1));
    if (Number.isFinite(background)) return backgroundIsLight(background) ? "light" : "dark";
  }

  return "dark";
}

export function bgTruecolor(rgb: Rgb): BgFn {
  return (text: string) => `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[49m`;
}

export function bgAnsi256(color: number): BgFn {
  return (text: string) => `\x1b[48;5;${color}m${text}\x1b[49m`;
}

function lerpRgb(start: Rgb, end: Rgb, rank: number): Rgb {
  return [
    Math.round(start[0] + (end[0] - start[0]) * rank),
    Math.round(start[1] + (end[1] - start[1]) * rank),
    Math.round(start[2] + (end[2] - start[2]) * rank)
  ];
}

function rgbToAnsi256(rgb: Rgb): number {
  const cube = nearestCubeColor(rgb);
  const gray = nearestGrayColor(rgb);
  return cube.distance <= gray.distance ? cube.color : gray.color;
}

function backgroundIsLight(colorIndex: number): boolean {
  const normalized = ((colorIndex % 16) + 16) % 16;
  return normalized === 7 || normalized >= 10;
}

function nearestCubeColor(rgb: Rgb): { color: number; distance: number } {
  const indexes = rgb.map((component) => nearestIndex(component, xtermLevels)) as [number, number, number];
  const color = 16 + 36 * indexes[0] + 6 * indexes[1] + indexes[2];
  return { color, distance: distance(rgb, [xtermLevels[indexes[0]], xtermLevels[indexes[1]], xtermLevels[indexes[2]]]) };
}

function nearestGrayColor(rgb: Rgb): { color: number; distance: number } {
  const average = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const index = Math.max(0, Math.min(23, Math.round((average - 8) / 10)));
  const level = 8 + index * 10;
  return { color: 232 + index, distance: distance(rgb, [level, level, level]) };
}

function nearestIndex(value: number, levels: readonly number[]): number {
  let best = 0;
  let bestDistance = Infinity;
  levels.forEach((level, index) => {
    const candidateDistance = Math.abs(value - level);
    if (candidateDistance < bestDistance) {
      best = index;
      bestDistance = candidateDistance;
    }
  });
  return best;
}

function distance(left: Rgb, right: Rgb): number {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}
