/**
 * Local model service — coding-agent adapter for LifecycleManager.
 *
 * Translates LocalModelDescriptor (generic, from pi-local) into
 * ProviderConfigInput (coding-agent specific) and registers models
 * with the ModelRegistry.
 *
 * This keeps the translation logic in coding-agent core (not UI code),
 * and keeps pi-local reusable by other consumers (OpenClaw, etc.).
 */

import type { LocalModelDescriptor } from "@mariozechner/pi-local";
import type { ModelRegistry, ProviderConfigInput } from "./model-registry.js";

/** Register discovered local models with a ModelRegistry. */
export function registerLocalModels(
	registry: ModelRegistry,
	providerName: string,
	descriptors: LocalModelDescriptor[],
): void {
	registry.registerProvider(providerName, {
		noAuth: true,
		baseUrl: "http://localhost:0/v1", // placeholder — prepare() provides real URL
		api: "openai-completions",
		models: descriptors.map((d) => ({
			id: d.id,
			name: d.name,
			reasoning: false,
			input: ["text"] as ("text" | "image")[],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: d.contextLength,
			maxTokens: d.maxOutputTokens,
			compat: d.compat,
		})),
	} as ProviderConfigInput);
}
