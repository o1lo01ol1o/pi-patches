import { createRequire } from "node:module";
import type { Terminal as XtermTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

export class VirtualTerminal {
  readonly terminal: XtermTerminal;
  readonly columns: number;
  readonly rows: number;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.terminal = new Terminal({ cols: columns, rows, allowProposedApi: true });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(data, resolve);
    });
  }

  line(row: number): string {
    return this.terminal.buffer.active.getLine(row)?.translateToString(true) ?? "";
  }

  screen(): string[] {
    return Array.from({ length: this.rows }, (_, row) => this.line(row));
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
