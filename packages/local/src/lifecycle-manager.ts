/**
 * LifecycleManager — orchestrates local model providers.
 *
 * Pure orchestrator: discovery, download, prepare-for-streaming, status tracking,
 * and disposal for all registered local providers (Foundry Local, Ollama, etc.).
 *
 * Consumer-agnostic — does NOT depend on any specific model registry shape.
 * Consumers (coding-agent, OpenClaw, etc.) translate LocalModelDescriptors into
 * their own model representations via an adapter layer.
 */

import type {
	LocalModelDescriptor,
	LocalProviderLifecycle,
	ModelLifecycleInfo,
	ModelLifecycleProvider,
} from "./types.js";

export class LifecycleManager implements ModelLifecycleProvider {
	private providers: Map<string, LocalProviderLifecycle> = new Map();
	private modelInfo: Map<string, ModelLifecycleInfo> = new Map();
	private discoveredModels: Map<string, LocalModelDescriptor[]> = new Map();
	private discoveryDone: Set<string> = new Set();
	private discoveryListeners: Array<(providerName: string, models: LocalModelDescriptor[]) => void> = [];

	/**
	 * Register a callback that fires whenever models are discovered for a provider.
	 * Used by consumer adapters to translate descriptors into their own registry format.
	 */
	onModelsDiscovered(listener: (providerName: string, models: LocalModelDescriptor[]) => void): void {
		this.discoveryListeners.push(listener);
	}

	/** Register a local provider. Clears stale discovery cache for replaced providers. */
	addProvider(provider: LocalProviderLifecycle): void {
		const existing = this.providers.get(provider.providerName);
		if (existing) {
			existing.dispose().catch(() => {});
			// Clear stale cache for the replaced provider
			this.discoveryDone.delete(provider.providerName);
			this.discoveredModels.delete(provider.providerName);
			for (const key of this.modelInfo.keys()) {
				if (key.startsWith(`${provider.providerName}:`)) {
					this.modelInfo.delete(key);
				}
			}
		}
		this.providers.set(provider.providerName, provider);
	}

	/** Check if a provider is already registered by name. */
	isProviderRegistered(providerName: string): boolean {
		return this.providers.has(providerName);
	}

	/** True if any registered provider is available on this platform. */
	hasProviders(): boolean {
		for (const p of this.providers.values()) {
			if (p.isAvailable()) return true;
		}
		return false;
	}

	/**
	 * Ensure all providers have discovered their models.
	 * Lazy — only runs once per provider until clearDiscovery() is called.
	 * Errors are swallowed — safe for background/model-selector use.
	 */
	async ensureDiscovered(): Promise<void> {
		for (const [name, provider] of this.providers) {
			if (this.discoveryDone.has(name)) continue;

			try {
				const descriptors = await provider.discoverModels();
				this.cacheDiscovery(name, descriptors);
				this.discoveryDone.add(name);
			} catch {
				// Discovery failed — don't mark done, so it retries next time.
			}
		}
	}

	/** Clear discovery state so next ensureDiscovered() re-runs. */
	clearDiscovery(): void {
		this.discoveryDone.clear();
		this.modelInfo.clear();
		this.discoveredModels.clear();
	}

	/**
	 * Discover models for a single provider, throwing on error.
	 * Returns the discovered descriptors for the caller to use.
	 * Unlike ensureDiscovered(), this does NOT swallow errors.
	 */
	async discoverForProvider(providerName: string): Promise<LocalModelDescriptor[]> {
		const provider = this.providers.get(providerName);
		if (!provider) throw new Error(`No lifecycle provider for "${providerName}"`);

		// Clear previous discovery for this provider so it re-runs
		this.discoveryDone.delete(providerName);

		const descriptors = await provider.discoverModels();
		this.cacheDiscovery(providerName, descriptors);
		this.discoveryDone.add(providerName);

		return descriptors;
	}

	/** Get previously discovered models for a provider. */
	getDiscoveredModels(providerName: string): LocalModelDescriptor[] {
		return this.discoveredModels.get(providerName) ?? [];
	}

	/** Get lifecycle info (status, download size) for a specific model. */
	getInfo(provider: string, modelId: string): ModelLifecycleInfo | undefined {
		return this.modelInfo.get(`${provider}:${modelId}`);
	}

	/** Download a model via its provider. */
	async download(provider: string, modelId: string, onProgress: (percent: number) => void): Promise<void> {
		const lifecycle = this.providers.get(provider);
		if (!lifecycle) throw new Error(`No lifecycle provider for "${provider}"`);
		await lifecycle.downloadModel(modelId, onProgress);

		// Update status to cached after successful download
		const key = `${provider}:${modelId}`;
		const existing = this.modelInfo.get(key);
		if (existing) {
			this.modelInfo.set(key, { ...existing, status: "cached" });
		}
	}

	/** Prepare a model for streaming. Returns baseUrl override if applicable. */
	async prepare(provider: string, modelId: string): Promise<{ baseUrl: string } | undefined> {
		const lifecycle = this.providers.get(provider);
		if (!lifecycle) return undefined;
		try {
			return await lifecycle.prepareForStreaming(modelId);
		} catch (error) {
			throw new Error(
				`Failed to prepare local model "${modelId}": ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** Dispose all providers. Uses allSettled so one failure doesn't block others. */
	async dispose(): Promise<void> {
		await Promise.allSettled([...this.providers.values()].map((p) => p.dispose()));
	}

	/** Cache discovery results and notify listeners. */
	private cacheDiscovery(providerName: string, descriptors: LocalModelDescriptor[]): void {
		this.discoveredModels.set(providerName, descriptors);

		for (const d of descriptors) {
			this.modelInfo.set(`${providerName}:${d.id}`, {
				status: d.status,
				downloadSize: d.downloadSize,
			});
		}

		for (const listener of this.discoveryListeners) {
			listener(providerName, descriptors);
		}
	}
}
