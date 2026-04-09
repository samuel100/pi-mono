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

export const FOUNDRY_LOCAL_PROVIDER = "foundry-local" as const;

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

	private async getOrCreateManager(): Promise<any> {
		if (this.sdkManager) return this.sdkManager;
		const { FoundryLocalManager } = await import("foundry-local-sdk");
		const origStdout = process.stdout.write;
		const origStderr = process.stderr.write;
		process.stdout.write = (() => true) as any;
		process.stderr.write = (() => true) as any;
		try {
			this.sdkManager = FoundryLocalManager.create({
				appName: "pi-foundry-local",
				logLevel: "fatal",
			});
		} finally {
			process.stdout.write = origStdout;
			process.stderr.write = origStderr;
		}
		return this.sdkManager;
	}

	// ── Web service (in-process, for streaming inference) ─────────────────

	/**
	 * Ensure the embedded web service is running.
	 * Returns the base URL (e.g., "http://127.0.0.1:54321").
	 */
	async ensureWebService(): Promise<string> {
		if (this.webServiceUrl) return this.webServiceUrl;
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
	}

	// ── Catalog + Download ───────────────────────────────────────────────

	async getCatalogModels(): Promise<LocalModelInfo[]> {
		if (!this.isAvailable()) return [];
		try {
			const manager = await this.getOrCreateManager();
			(manager.catalog as any).lastFetch = 0;
			const models = await manager.catalog.getModels();
			const results = models.map((m: any) => ({
				alias: m.alias,
				displayName: m.alias,
				fileSizeMb: null,
				isCached: m.isCached,
				supportsToolCalling: false,
				contextLength: null,
				maxOutputTokens: null,
			}));
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

	async loadModel(alias: string): Promise<void> {
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!(await model.isLoaded())) {
			process.stderr.write(`\x1b[33mLoading ${alias} into memory...\x1b[0m\n`);
			await model.load();
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
			name: `${m.displayName} (Foundry Local)`,
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
