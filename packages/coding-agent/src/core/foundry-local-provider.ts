/**
 * Foundry Local provider — in-process SDK with embedded web server.
 *
 * Architecture:
 *   - FoundryLocalManager runs in the Pi process.
 *   - SDK handles catalog discovery, model download, load/unload.
 *   - Embedded web server (startWebService) provides OpenAI-compatible
 *     HTTP endpoint for streaming inference — this integrates naturally
 *     with Node.js event loop for smooth token-by-token rendering.
 *   - Everything dies when Pi quits. No separate process, no lockfile.
 */

import { createRequire } from "node:module";
import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";

const cjsRequire = createRequire(import.meta.url);

export const FOUNDRY_LOCAL_PROVIDER = "local" as const;

const FOUNDRY_LOCAL_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};

export interface LocalModelInfo {
	alias: string;
	displayName: string;
	fileSizeMb: number | null;
	isCached: boolean;
	supportsToolCalling: boolean;
	contextLength: number | null;
	maxOutputTokens: number | null;
}

export class FoundryLocalProvider {
	private sdkAvailable: boolean | null = null;
	private sdkManager: any = null;
	private catalogAliases: Set<string> = new Set();
	private webServiceUrl: string | null = null;
	private webServicePromise: Promise<string> | null = null;
	private loadingPromise: Promise<void> | null = null;

	isAvailable(): boolean {
		if (this.sdkAvailable !== null) return this.sdkAvailable;
		try {
			cjsRequire.resolve("foundry-local-sdk");
			this.sdkAvailable = true;
		} catch {
			this.sdkAvailable = false;
		}
		return this.sdkAvailable;
	}

	/** Get the web service base URL, or null if not started. */
	getBaseUrl(): string | null {
		return this.webServiceUrl;
	}

	// ── SDK manager ──────────────────────────────────────────────────────

	/**
	 * Why dup/dup2?
	 *
	 * The Foundry Local SDK's native ONNX Runtime core prints
	 * "Service configuration complete." by writing directly to file
	 * descriptor 1 (stdout) from C++ code.  This bypasses Node.js
	 * entirely — overriding process.stdout.write has no effect.
	 *
	 * To suppress it we use POSIX fd manipulation via koffi (already
	 * a Pi dependency for Windows VT input):
	 *   1. dup(1)        → duplicate fd 1 into a new fd (savedFd)
	 *   2. dup2(null, 1) → point fd 1 at /dev/null (mutes native writes)
	 *   3. create the manager (native init writes to fd 1 → /dev/null)
	 *   4. dup2(saved, 1)→ restore fd 1 to the real terminal
	 *   5. close(savedFd)→ release the duplicate
	 *
	 * The finally block guarantees savedFd is always closed, even if
	 * manager creation throws.
	 */
	private async getOrCreateManager(): Promise<any> {
		if (this.sdkManager) return this.sdkManager;
		const { FoundryLocalManager } = await import("foundry-local-sdk");
		const fs = await import("node:fs");

		let savedFd = -1;
		let closeFd: (fd: number) => number = () => 0;
		let dup2Fn: (oldFd: number, newFd: number) => number = () => 0;

		try {
			const koffi = cjsRequire("koffi");
			const libName = process.platform === "darwin" ? "libSystem.dylib" : "libc.so.6";
			const libc = koffi.load(libName);
			const dup: (fd: number) => number = libc.func("int dup(int)");
			dup2Fn = libc.func("int dup2(int, int)");
			closeFd = libc.func("int close(int)");

			savedFd = dup(1);
			const nullFd = fs.openSync("/dev/null", "w");
			dup2Fn(nullFd, 1);
			fs.closeSync(nullFd);

			this.sdkManager = FoundryLocalManager.create({
				appName: "pi-foundry-local",
				logLevel: "fatal",
			});
		} catch {
			// Fallback: create manager without fd suppression
			if (!this.sdkManager) {
				this.sdkManager = FoundryLocalManager.create({
					appName: "pi-foundry-local",
					logLevel: "fatal",
				});
			}
		} finally {
			// Always restore stdout and close the saved fd
			if (savedFd !== -1) {
				try {
					dup2Fn(savedFd, 1);
					closeFd(savedFd);
				} catch {
					/* best effort — fd may leak, but Pi still works */
				}
			}
		}
		return this.sdkManager;
	}

	// ── Web service (in-process, for streaming inference) ─────────────────

	/**
	 * Ensure the embedded web service is running.
	 * Returns the base URL (e.g., "http://127.0.0.1:54321").
	 * Promise-cached so concurrent callers share one startup.
	 */
	async ensureWebService(): Promise<string> {
		if (this.webServiceUrl) return this.webServiceUrl;
		if (this.webServicePromise) return this.webServicePromise;

		this.webServicePromise = (async () => {
			const manager = await this.getOrCreateManager();
			if (!manager.isWebServiceRunning) {
				manager.startWebService();
			}
			const urls: string[] = manager.urls;
			if (!urls || urls.length === 0) {
				throw new Error("Failed to start Foundry Local web service");
			}
			this.webServiceUrl = urls[0];
			return this.webServiceUrl;
		})();

		try {
			return await this.webServicePromise;
		} catch (e) {
			this.webServicePromise = null;
			throw e;
		}
	}

	// ── Catalog + Download ───────────────────────────────────────────────

	async getCatalogModels(): Promise<LocalModelInfo[]> {
		if (!this.isAvailable()) return [];
		try {
			const manager = await this.getOrCreateManager();
			(manager.catalog as any).lastFetch = 0;
			const models = await manager.catalog.getModels();
			const results = models
				.map((m: any) => ({
					alias: m.alias,
					displayName: m.alias,
					fileSizeMb: null,
					isCached: m.isCached,
					supportsToolCalling: m.supportsToolCalling ?? false,
					contextLength: m.contextLength ?? null,
					maxOutputTokens: null,
				}))
				// Only show models that support tool calling (required for Pi's agentic workflows)
				.filter((m: LocalModelInfo) => m.supportsToolCalling);
			this.catalogAliases = new Set(results.map((m: LocalModelInfo) => m.alias));
			return results;
		} catch (error) {
			console.error(
				`Failed to query Foundry Local catalog: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	async downloadModel(alias: string, onProgress?: (percent: number) => void): Promise<void> {
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!model.isCached) {
			await model.download(onProgress);
		}
	}

	// ── Model load / unload ──────────────────────────────────────────────

	/**
	 * Load a model, serializing concurrent requests so we never
	 * unload + load in parallel (which could leave the service
	 * with zero models loaded).
	 */
	async loadModel(alias: string): Promise<void> {
		while (this.loadingPromise) {
			await this.loadingPromise;
		}
		this.loadingPromise = this._loadModelImpl(alias);
		try {
			await this.loadingPromise;
		} finally {
			this.loadingPromise = null;
		}
	}

	private async _loadModelImpl(alias: string): Promise<void> {
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!(await model.isLoaded())) {
			await this.unloadAll();
			process.stderr.write(`\x1b[33mLoading ${alias} into memory...\x1b[0m\n`);
			await model.load();
		}
	}

	/** Unload all currently loaded models. */
	async unloadAll(): Promise<void> {
		if (!this.sdkManager) return;
		try {
			const loaded = await this.sdkManager.catalog.getLoadedModels();
			for (const model of loaded) {
				try {
					await model.unload();
				} catch {
					// Best-effort
				}
			}
		} catch {
			// Ignore
		}
	}

	async listLoadedModels(): Promise<string[]> {
		if (!this.sdkManager) return [];
		try {
			const models = await this.sdkManager.catalog.getLoadedModels();
			const loadedAliases: string[] = [];
			for (const m of models) {
				const id: string = m.id ?? m.alias ?? "";
				const sortedAliases = [...this.catalogAliases].sort((a, b) => b.length - a.length);
				for (const alias of sortedAliases) {
					if (id.startsWith(alias)) {
						loadedAliases.push(alias);
						break;
					}
				}
			}
			return loadedAliases;
		} catch {
			return [];
		}
	}

	/**
	 * Unload all loaded models and stop web service.
	 * Call on Pi shutdown to prevent OGA memory leaks.
	 */
	async cleanup(): Promise<void> {
		if (!this.sdkManager) return;
		try {
			if (this.sdkManager.isWebServiceRunning) {
				this.sdkManager.stopWebService();
			}
			const loadedModels = await this.sdkManager.catalog.getLoadedModels();
			for (const model of loadedModels) {
				try {
					await model.unload();
				} catch {
					// Best-effort cleanup
				}
			}
		} catch {
			// Ignore errors during cleanup
		}
		this.webServiceUrl = null;
	}

	// ── Pi model mapping ─────────────────────────────────────────────────

	buildPiModels(catalogModels: LocalModelInfo[], baseUrl: string): Model<"openai-completions">[] {
		return catalogModels.map((m) => ({
			id: m.alias,
			name: m.displayName,
			api: "openai-completions" as const,
			provider: FOUNDRY_LOCAL_PROVIDER,
			baseUrl: `${baseUrl}/v1`,
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextLength ?? 32768,
			maxTokens: m.maxOutputTokens ?? 4096,
			compat: FOUNDRY_LOCAL_COMPAT,
		}));
	}
}
