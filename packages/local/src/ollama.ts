/**
 * Ollama provider — HTTP API integration for local model management.
 *
 * Architecture:
 *   - Ollama runs as a separate server process (managed by the user).
 *   - Pi communicates via Ollama's REST API at localhost:11434.
 *   - Ollama exposes an OpenAI-compatible endpoint at /v1 for streaming inference.
 *   - Pi discovers locally available models, can pull new ones, and streams
 *     completions through the /v1 endpoint.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { LocalModelDescriptor, LocalProviderLifecycle } from "./types.js";

export const OLLAMA_PROVIDER = "ollama" as const;
const OLLAMA_BASE = "http://localhost:11434";

export const OLLAMA_COMPAT: OpenAICompletionsCompat = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	maxTokensField: "max_tokens",
	supportsStrictMode: false,
};

// ── Curated catalog of popular tool-calling models ──────────────────
// Loaded from ollama-models.json — edit that file to add/remove models.
// These appear as "available" for download when not already installed.

interface CatalogEntry {
	name: string;
	contextLength: number;
	sizeBytes: number;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const catalogPath = join(__dirname, "ollama-models.json");
const catalogData: { models: CatalogEntry[] } = JSON.parse(readFileSync(catalogPath, "utf-8"));
const OLLAMA_CATALOG: CatalogEntry[] = catalogData.models;

// ── Ollama API response types ────────────────────────────────────────

interface OllamaModelDetails {
	parent_model?: string;
	format?: string;
	family?: string;
	families?: string[];
	parameter_size?: string;
	quantization_level?: string;
}

interface OllamaTagModel {
	name: string;
	model: string;
	modified_at: string;
	size: number;
	digest: string;
	details: OllamaModelDetails;
}

interface OllamaTagsResponse {
	models: OllamaTagModel[];
}

interface OllamaPsModel {
	name: string;
	model: string;
	size: number;
	digest: string;
	details: OllamaModelDetails;
	expires_at: string;
	size_vram: number;
}

interface OllamaPsResponse {
	models: OllamaPsModel[];
}

interface OllamaShowResponse {
	model_info?: Record<string, unknown>;
	details?: OllamaModelDetails;
	capabilities?: string[];
}

interface OllamaPullProgress {
	status: string;
	digest?: string;
	total?: number;
	completed?: number;
}

// ── Helper functions ─────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	const gb = bytes / (1024 * 1024 * 1024);
	if (gb >= 1) return `${gb.toFixed(1)} GB`;
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(0)} MB`;
}

/**
 * Normalize Ollama model name for consistent matching.
 * Ollama uses "name:tag" format (e.g., "llama3.2:latest").
 * The /api/ps response may return names without the tag.
 */
function normalizeModelName(name: string): string {
	return name.includes(":") ? name : `${name}:latest`;
}

async function ollamaFetch<T>(path: string, options?: RequestInit): Promise<T> {
	const url = `${OLLAMA_BASE}${path}`;
	const response = await fetch(url, {
		...options,
		headers: { "Content-Type": "application/json", ...options?.headers },
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Ollama API error: ${response.status} ${response.statusText} - ${body}`);
	}
	return response.json() as Promise<T>;
}

/**
 * Check if the Ollama server is reachable.
 * Used internally to validate availability before API calls.
 */
async function isOllamaServerRunning(): Promise<boolean> {
	try {
		const response = await fetch(`${OLLAMA_BASE}/api/version`, {
			signal: AbortSignal.timeout(2000),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Query model info to get context length and capabilities.
 * Falls back to defaults if the call fails.
 */
async function getModelInfo(modelName: string): Promise<{ contextLength: number; supportsToolCalling: boolean }> {
	try {
		const info = await ollamaFetch<OllamaShowResponse>("/api/show", {
			method: "POST",
			body: JSON.stringify({ name: modelName }),
		});

		// Check tool-calling capability
		const capabilities = info.capabilities ?? [];
		const supportsToolCalling = capabilities.includes("tools");

		// Ollama stores context length in model_info under various keys
		let contextLength = 4096;
		const modelInfo = info.model_info ?? {};
		for (const key of Object.keys(modelInfo)) {
			if (key.endsWith(".context_length") && typeof modelInfo[key] === "number") {
				contextLength = modelInfo[key] as number;
				break;
			}
		}

		return { contextLength, supportsToolCalling };
	} catch {
		return { contextLength: 4096, supportsToolCalling: false };
	}
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a LocalProviderLifecycle backed by Ollama's HTTP API.
 * Requires Ollama to be installed and running (`ollama serve`).
 */
export function createOllamaProvider(): LocalProviderLifecycle {
	return {
		providerName: OLLAMA_PROVIDER,

		isAvailable: (): boolean => {
			// Sync constraint: check if the `ollama` binary exists on PATH.
			// This doesn't confirm the server is running, but it's a fast
			// pre-check. If the server isn't running, discoverModels() will
			// surface the error clearly.
			try {
				const cmd = process.platform === "win32" ? "where ollama" : "which ollama";
				execSync(cmd, { stdio: "ignore", timeout: 2000 });
				return true;
			} catch {
				return false;
			}
		},

		discoverModels: async (): Promise<LocalModelDescriptor[]> => {
			// Verify server is actually running before making API calls
			const running = await isOllamaServerRunning();
			if (!running) {
				throw new Error("Ollama server is not running. Start it with: ollama serve");
			}

			// Fetch local models and running models in parallel
			const [tagsResponse, psResponse] = await Promise.all([
				ollamaFetch<OllamaTagsResponse>("/api/tags"),
				ollamaFetch<OllamaPsResponse>("/api/ps"),
			]);

			const loadedNames = new Set((psResponse.models ?? []).map((m) => normalizeModelName(m.name)));
			const localModels = tagsResponse.models ?? [];

			// Build set of locally installed model names for catalog deduplication
			const localNames = new Set(localModels.map((m) => normalizeModelName(m.name)));

			// Fetch model info (context length) for local models in parallel
			const modelInfos = await Promise.all(localModels.map((m) => getModelInfo(m.name)));

			// Local models: "loaded" or "cached"
			const descriptors: LocalModelDescriptor[] = localModels.map((m, i) => {
				const normalized = normalizeModelName(m.name);
				return {
					id: m.name,
					name: m.name,
					status: loadedNames.has(normalized) ? ("loaded" as const) : ("cached" as const),
					downloadSize: formatBytes(m.size),
					contextLength: modelInfos[i].contextLength,
					maxOutputTokens: 4096,
					compat: OLLAMA_COMPAT as unknown as Record<string, boolean | string>,
				};
			});

			// Catalog models not yet installed: "available" for download
			for (const entry of OLLAMA_CATALOG) {
				const normalized = normalizeModelName(entry.name);
				if (localNames.has(normalized)) continue;
				descriptors.push({
					id: entry.name,
					name: entry.name,
					status: "available",
					downloadSize: formatBytes(entry.sizeBytes),
					contextLength: entry.contextLength,
					maxOutputTokens: 4096,
					compat: OLLAMA_COMPAT as unknown as Record<string, boolean | string>,
				});
			}

			return descriptors;
		},

		downloadModel: async (modelId: string, onProgress: (percent: number) => void): Promise<void> => {
			const response = await fetch(`${OLLAMA_BASE}/api/pull`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: modelId, stream: true }),
			});

			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(`Failed to pull model: ${response.status} - ${body}`);
			}

			if (!response.body) {
				throw new Error("No response body from Ollama pull endpoint");
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			let succeeded = false;

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });

					// Ollama streams newline-delimited JSON
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						const trimmed = line.trim();
						if (!trimmed) continue;

						try {
							const progress = JSON.parse(trimmed) as OllamaPullProgress;
							if (progress.status === "success") {
								succeeded = true;
							} else if (progress.total && progress.completed) {
								const pct = (progress.completed / progress.total) * 100;
								onProgress(Math.min(pct, 99));
							}
							// Ignore progress-less status lines (e.g., "pulling manifest")
						} catch {
							// Skip malformed JSON lines
						}
					}
				}

				// Process any remaining data in buffer
				if (buffer.trim()) {
					try {
						const progress = JSON.parse(buffer.trim()) as OllamaPullProgress;
						if (progress.status === "success") {
							succeeded = true;
						} else if (progress.total && progress.completed) {
							onProgress(Math.min((progress.completed / progress.total) * 100, 99));
						}
					} catch {
						// Ignore
					}
				}

				if (succeeded) {
					onProgress(100);
				} else {
					throw new Error("Model pull did not complete successfully");
				}
			} finally {
				reader.releaseLock();
			}
		},

		prepareForStreaming: async (modelId: string): Promise<{ baseUrl: string }> => {
			// Ollama auto-loads models on first inference request, but we can
			// pre-warm by sending an empty generate request. This loads the model
			// into memory before the user's first real prompt.
			try {
				await fetch(`${OLLAMA_BASE}/api/generate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ model: modelId, prompt: "", stream: false }),
				});
			} catch {
				// Best effort — model will load on first real request
			}

			return { baseUrl: `${OLLAMA_BASE}/v1` };
		},

		dispose: async (): Promise<void> => {
			// Ollama manages its own server lifecycle.
			// Nothing to clean up from Pi's side.
		},
	};
}
