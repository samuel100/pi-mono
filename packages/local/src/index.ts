// Generic lifecycle types (provider-agnostic)

// Foundry Local provider implementation
export {
	createFoundryLocalProvider,
	FOUNDRY_LOCAL_COMPAT,
	FOUNDRY_LOCAL_PROVIDER,
	FoundryLocalManager,
	type LocalModelInfo,
} from "./foundry-local.js";
// Lifecycle manager (orchestrates local providers)
export { LifecycleManager } from "./lifecycle-manager.js";
// Ollama provider implementation
export { createOllamaProvider, OLLAMA_COMPAT, OLLAMA_PROVIDER } from "./ollama.js";
export type {
	LocalModelDescriptor,
	LocalProviderLifecycle,
	ModelLifecycleInfo,
	ModelLifecycleProvider,
} from "./types.js";
