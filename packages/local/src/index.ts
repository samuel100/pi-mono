// Generic lifecycle types (provider-agnostic)

// Foundry Local provider implementation
export {
	createFoundryLocalProvider,
	FOUNDRY_LOCAL_COMPAT,
	FOUNDRY_LOCAL_PROVIDER,
	FoundryLocalManager,
	type LocalModelInfo,
} from "./foundry-local.js";
export type { LocalModelDescriptor, LocalProviderLifecycle } from "./types.js";
