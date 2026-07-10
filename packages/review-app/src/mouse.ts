export type MouseEvent =
  | { kind: "press"; button: number; x: number; y: number }
  | { kind: "release"; button: number; x: number; y: number }
  | { kind: "move"; button: number; x: number; y: number }
  | { kind: "wheel"; direction: "up" | "down"; x: number; y: number };

export function parseSgrMouse(input: string): MouseEvent | null {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input);
  if (!match) return null;
  return decodeSgrMouse(match);
}

export function parseSgrMouseEvents(input: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of input.matchAll(pattern)) {
    const event = decodeSgrMouse(match);
    if (event) events.push(event);
  }
  return events;
}

function decodeSgrMouse(match: RegExpMatchArray): MouseEvent | null {
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isInteger(code) || !Number.isInteger(x) || !Number.isInteger(y) || x < 1 || y < 1) return null;
  const release = match[4] === "m";
  const unmodified = code & ~(4 | 8 | 16);
  if (unmodified === 64 || unmodified === 65) {
    return { kind: "wheel", direction: unmodified === 64 ? "up" : "down", x, y };
  }
  if (unmodified === 66 || unmodified === 67) return null;
  const button = code & 3;
  if (release) return { kind: "release", button, x, y };
  if ((code & 32) !== 0) return { kind: "move", button, x, y };
  return { kind: "press", button, x, y };
}
