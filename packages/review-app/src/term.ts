export type TerminalCleanup = () => void;

export function enterAltScreen(write: (chunk: string) => void = (chunk) => process.stdout.write(chunk)): TerminalCleanup {
  let active = true;
  write("\x1b[?1049h");
  return () => {
    if (!active) return;
    active = false;
    write("\x1b[?1049l");
  };
}

export function enableMouseTracking(write: (chunk: string) => void = (chunk) => process.stdout.write(chunk)): TerminalCleanup {
  let active = true;
  write("\x1b[?1002h\x1b[?1006h");
  return () => {
    if (!active) return;
    active = false;
    write("\x1b[?1002l\x1b[?1006l");
  };
}
