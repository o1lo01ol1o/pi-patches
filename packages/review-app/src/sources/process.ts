import { spawnSync } from "node:child_process";
import { err, ok, type Result } from "@pi-patches/store";

export type CommandRequest = {
  command: string;
  args: readonly string[];
  cwd: string;
};

export type CommandOutput = {
  stdout: Buffer;
  stderr: string;
};

export interface CommandRunner {
  run(request: CommandRequest): Result<CommandOutput>;
}

export const systemCommandRunner: CommandRunner = {
  run(request) {
    try {
      const result = spawnSync(request.command, [...request.args], {
        cwd: request.cwd,
        encoding: null,
        maxBuffer: 256 * 1024 * 1024,
        env: process.env
      });
      if (result.error) return err({ kind: "Io", path: request.command, message: result.error.message });
      const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8") : "";
      if (result.status !== 0) {
        return err({
          kind: "Io",
          path: `${request.command} ${request.args.join(" ")}`,
          message: stderr.trim() || `command exited ${result.status ?? "without status"}`
        });
      }
      return ok({ stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0), stderr });
    } catch (error) {
      return err({ kind: "Io", path: request.command, message: error instanceof Error ? error.message : String(error) });
    }
  }
};

export function runText(runner: CommandRunner, cwd: string, command: string, args: readonly string[]): Result<string> {
  const result = runner.run({ command, args, cwd });
  if (!result.ok) return result;
  try {
    return ok(new TextDecoder("utf-8", { fatal: true }).decode(result.value.stdout));
  } catch (error) {
    return err({
      kind: "Io",
      path: `${command} ${args.join(" ")}`,
      message: `expected UTF-8 output: ${error instanceof Error ? error.message : String(error)}`
    });
  }
}

export function runBytes(runner: CommandRunner, cwd: string, command: string, args: readonly string[]): Result<Buffer> {
  const result = runner.run({ command, args, cwd });
  return result.ok ? ok(result.value.stdout) : result;
}
