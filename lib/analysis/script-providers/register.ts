import { registerScriptProvider } from "./registry";
import { falVideoUnderstandingProvider } from "./fal-video-understanding";

let registered = false;

export function registerBuiltinScriptProviders(): void {
  if (registered) return;
  registerScriptProvider(falVideoUnderstandingProvider);
  registered = true;
}
