/**
 * Foundry Local provider — manages the Foundry Local service process and
 * exposes its models as a built-in Pi provider.
 *
 * Architecture:
 *   - A detached service process runs Foundry Local's embedded web service
 *     (OpenAI-compatible v1/chat/completions endpoint + model management).
 *   - Pi CLI uses the SDK for catalog discovery and model downloading
 *     (these are network/file operations that don't need inference).
 *   - Pi CLI uses HTTP for model load/unload and inference on the service.
 *   - Pi's existing openai-completions provider handles SSE and tool calling.
 */

import { type ChildProcess, fork, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const cjsRequire = createRequire(import.meta.url);

export const FOUNDRY_LOCAL_PROVIDER = "foundry-local" as const;

/** Compat settings for Foundry Local's OpenAI-compatible web service. */
const FOUNDRY_LOCAL_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};

/** Information about a model in the Foundry Local catalog. */
export interface LocalModelInfo {
	alias: string;
	displayName: string;
	fileSizeMb: number | null;
	isCached: boolean;
	supportsToolCalling: boolean;
	contextLength: number | null;
	maxOutputTokens: number | null;
}

/** Lockfile written by the service process. */
interface ServiceLockfile {
	pid: number;
	port: number;
	urls: string[];
	startedAt: string;
}

const SERVICE_START_TIMEOUT_MS = 30_000;

export class FoundryLocalProvider {
	private lockfilePath: string;
	private baseUrl: string | null = null;
	private sdkAvailable: boolean | null = null;
	private sdkManager: any = null;

	constructor(agentDir: string) {
		this.lockfilePath = join(agentDir, "foundry-local-service.json");
	}

	/**
	 * Check if the Foundry Local SDK native binaries are available.
	 */
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

	/** Get the base URL of the running service, or null if not connected. */
	getBaseUrl(): string | null {
		return this.baseUrl;
	}

	// ── Service lifecycle (spawn / connect) ──────────────────────────────

	/**
	 * Ensure the Foundry Local service process is running.
	 * Reads the lockfile to find an existing service, or spawns a new one.
	 */
	async ensureServiceRunning(): Promise<string> {
		if (this.baseUrl && (await this.healthCheck(this.baseUrl))) {
			return this.baseUrl;
		}

		const existing = this.readLockfile();
		if (existing) {
			const url = existing.urls[0];
			if (await this.healthCheck(url)) {
				this.baseUrl = url;
				return url;
			}
			this.removeLockfile();
		}

		return this.spawnService();
	}

	// ── Catalog + Download (SDK-based, runs in Pi CLI process) ───────────

	/**
	 * Get or create the FoundryLocalManager singleton for catalog/download operations.
	 * Suppresses the native core's init log that would corrupt the TUI.
	 */
	private async getOrCreateManager(): Promise<any> {
		if (this.sdkManager) return this.sdkManager;
		const { FoundryLocalManager } = await import("foundry-local-sdk");

		// Suppress native core's "Service configuration complete." log
		const origWrite = process.stdout.write;
		process.stdout.write = (() => true) as any;
		try {
			this.sdkManager = FoundryLocalManager.create({
				appName: "pi-foundry-local",
				logLevel: "fatal",
			});
		} finally {
			process.stdout.write = origWrite;
		}
		return this.sdkManager;
	}

	/**
	 * Query the full Foundry Local catalog for all available models
	 * (including those not yet cached/downloaded).
	 * Uses the SDK directly — /v1/models only returns cached models.
	 */
	async getCatalogModels(): Promise<LocalModelInfo[]> {
		if (!this.isAvailable()) return [];

		try {
			const manager = await this.getOrCreateManager();
			// Reset the catalog's time-based cache so isCached reflects current disk state.
			// The catalog caches for 6 hours; we need fresh data each time the selector opens.
			(manager.catalog as any).lastFetch = 0;
			const models = await manager.catalog.getModels();
			return models.map((m: any) => ({
				alias: m.alias,
				displayName: m.alias,
				fileSizeMb: null,
				isCached: m.isCached,
				supportsToolCalling: false,
				contextLength: null,
				maxOutputTokens: null,
			}));
		} catch (error) {
			console.error(
				`Failed to query Foundry Local catalog: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	/**
	 * Download a model from the Foundry Local catalog.
	 * Uses the SDK directly for download with progress tracking.
	 */
	async downloadModel(alias: string, onProgress?: (percent: number) => void): Promise<void> {
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!model.isCached) {
			await model.download(onProgress);
		}
	}

	// ── Load / Unload / Inference (HTTP to the long-lived service) ───────

	/**
	 * Load an already-cached model on the service.
	 * The model must be downloaded first via downloadModel().
	 */
	async loadModel(name: string): Promise<void> {
		if (!this.baseUrl) throw new Error("Service not running");
		const response = await fetch(`${this.baseUrl}/models/load/${encodeURIComponent(name)}`, {
			signal: AbortSignal.timeout(60_000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(`Failed to load model '${name}': ${text}`);
		}
	}

	/** Unload a model from the service. */
	async unloadModel(name: string): Promise<void> {
		if (!this.baseUrl) throw new Error("Service not running");
		const response = await fetch(`${this.baseUrl}/models/unload/${encodeURIComponent(name)}`, {
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(`Failed to unload model '${name}': ${text}`);
		}
	}

	/** List models currently loaded on the service. */
	async listLoadedModels(): Promise<string[]> {
		if (!this.baseUrl) return [];
		try {
			const response = await fetch(`${this.baseUrl}/models/loaded`, {
				signal: AbortSignal.timeout(5_000),
			});
			if (!response.ok) return [];
			return (await response.json()) as string[];
		} catch {
			return [];
		}
	}

	/**
	 * Ensure a model is downloaded and loaded on the service.
	 * Downloads via SDK if not cached, then loads via HTTP.
	 */
	async ensureModelReady(alias: string, onProgress?: (percent: number) => void): Promise<void> {
		await this.downloadModel(alias, onProgress);
		await this.loadModel(alias);
	}

	// ── Pi model mapping ─────────────────────────────────────────────────

	/**
	 * Convert catalog models to pi-ai Model objects for registration.
	 */
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

	// ── Private helpers ──────────────────────────────────────────────────

	private readLockfile(): ServiceLockfile | null {
		try {
			if (!existsSync(this.lockfilePath)) return null;
			return JSON.parse(readFileSync(this.lockfilePath, "utf-8")) as ServiceLockfile;
		} catch {
			return null;
		}
	}

	private removeLockfile(): void {
		try {
			if (existsSync(this.lockfilePath)) unlinkSync(this.lockfilePath);
		} catch {
			// Ignore
		}
	}

	private async healthCheck(url: string): Promise<boolean> {
		try {
			const response = await fetch(`${url}/models/loaded`, {
				signal: AbortSignal.timeout(3_000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	private async spawnService(): Promise<string> {
		// Resolve the service script path. When running from source (tsx), __dirname
		// points to the .ts source. When running compiled, it points to dist/.
		// We try the .js path first (compiled), then fall back to .ts via tsx.
		const jsPath = join(__dirname, "foundry-local-service.js");
		const tsPath = join(__dirname, "foundry-local-service.ts");
		const useTs = !existsSync(jsPath) && existsSync(tsPath);
		const servicePath = useTs ? tsPath : jsPath;

		return new Promise<string>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`Foundry Local service did not start within ${SERVICE_START_TIMEOUT_MS / 1000}s`));
			}, SERVICE_START_TIMEOUT_MS);

			let child: ChildProcess;
			if (useTs) {
				// Running from source — use tsx to execute the TypeScript service
				const tsxBin = join(__dirname, "..", "..", "..", "..", "node_modules", ".bin", "tsx");
				child = spawn(tsxBin, [servicePath, this.lockfilePath], {
					detached: true,
					stdio: ["ignore", "pipe", "ignore"],
				});
				child.unref();
			} else {
				child = fork(servicePath, [this.lockfilePath], {
					detached: true,
					stdio: ["ignore", "pipe", "ignore", "ipc"],
				});
			}

			child.unref();

			let stdoutData = "";

			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutData += chunk.toString();
				try {
					const parsed = JSON.parse(stdoutData.trim());
					if (parsed.ready && parsed.urls?.length > 0) {
						clearTimeout(timeout);
						this.baseUrl = parsed.urls[0];
						// Close stdout pipe and disconnect IPC so child is fully detached
						child.stdout?.destroy();
						if (typeof child.disconnect === "function") child.disconnect();
						resolve(this.baseUrl!);
					}
				} catch {
					// Not yet complete JSON
				}
			});

			child.on("error", (err) => {
				clearTimeout(timeout);
				reject(new Error(`Failed to spawn Foundry Local service: ${err.message}`));
			});

			child.on("exit", (code) => {
				clearTimeout(timeout);
				if (code !== 0) {
					reject(new Error(`Foundry Local service exited with code ${code}`));
				}
			});
		});
	}
}
