/**
 * Generic local provider lifecycle types.
 *
 * These interfaces define the contract for any local model runtime
 * (Foundry Local, Ollama, LM Studio, etc.) to plug into Pi's coding-agent.
 * They use neutral types — no dependency on pi-ai's Model type.
 */

/**
 * Neutral model descriptor returned by local providers during discovery.
 * The coding-agent's ModelRegistry converts these into Model<Api> objects.
 */
export interface LocalModelDescriptor {
	id: string;
	name: string;
	status: "loaded" | "cached" | "available";
	downloadSize?: string;
	contextLength: number;
	maxOutputTokens: number;
	compat?: Record<string, boolean | string>;
}

/**
 * Lifecycle interface for any local model provider.
 * Implement this to plug a new local runtime into Pi's coding-agent.
 *
 * @example
 * // Foundry Local
 * import { createFoundryLocalProvider } from "@mariozechner/pi-local";
 * const provider = createFoundryLocalProvider();
 *
 * @example
 * // Custom provider
 * const provider: LocalProviderLifecycle = {
 *   providerName: "ollama",
 *   isAvailable: () => true,
 *   discoverModels: async () => [{ id: "llama3", name: "Llama 3", status: "cached", ... }],
 *   downloadModel: async (id, onProgress) => { ... },
 *   prepareForStreaming: async (id) => ({ baseUrl: "http://localhost:11434/v1" }),
 *   dispose: async () => {},
 * };
 */
export interface LocalProviderLifecycle {
	/** Provider name for registration (e.g., "local", "ollama"). */
	readonly providerName: string;

	/** Check if runtime is available on this platform. */
	isAvailable(): boolean;

	/** Discover models with status metadata. May be slow (~18s for catalog providers). */
	discoverModels(): Promise<LocalModelDescriptor[]>;

	/** Download a model. Called when user selects an 'available' model. */
	downloadModel(modelId: string, onProgress: (percent: number) => void): Promise<void>;

	/** Prepare model for streaming. Returns the baseUrl to use for inference. */
	prepareForStreaming(modelId: string): Promise<{ baseUrl: string }>;

	/** Clean up resources (web service, loaded models). */
	dispose(): Promise<void>;
}
