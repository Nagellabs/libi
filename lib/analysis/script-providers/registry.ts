import type { ScriptProvider } from "./types";

const providers = new Map<string, ScriptProvider>();
const registrationOrder: string[] = [];

export function registerScriptProvider(provider: ScriptProvider): void {
  if (providers.has(provider.id)) {
    throw new Error(`Script provider already registered: ${provider.id}`);
  }
  providers.set(provider.id, provider);
  registrationOrder.push(provider.id);
}

export function getScriptProvider(id?: string): ScriptProvider {
  if (providers.size === 0) {
    throw new Error("No script providers are registered");
  }
  if (id === undefined) {
    return providers.get(registrationOrder[0])!;
  }
  const p = providers.get(id);
  if (!p) {
    throw new Error(`Unknown script provider: ${id}`);
  }
  return p;
}

export function listScriptProviders(): ScriptProvider[] {
  return registrationOrder.map((id) => providers.get(id)!);
}

export function __resetScriptProviderRegistryForTests(): void {
  providers.clear();
  registrationOrder.length = 0;
}
