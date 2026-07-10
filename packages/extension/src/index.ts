import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { registerRecorder } from "./recorder.ts";

export default function piPatchesExtension(pi: ExtensionAPI): void {
  registerRecorder(pi);
  registerCommands(pi);
}
