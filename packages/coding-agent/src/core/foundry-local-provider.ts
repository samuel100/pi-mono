/**
 * Foundry Local provider — in-process SDK integration.
 *
 * Architecture:
 *   - FoundryLocalManager runs in the Pi process (no separate service).
 *   - SDK handles catalog discovery, model download, load/unload.
 *   - Native chatClient.completeStreamingChat() for inference (no HTTP).
 *   - Models stay loaded for the duration of the Pi TUI session.
 */

import { createRequire } from "node:module";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	OpenAICompletionsCompat,
	SimpleStreamOptions,
	ToolCall,
} from "@mariozechner/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@mariozechner/pi-ai";

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
	private loadedChatClients: Map<string, any> = new Map();

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

	// ── SDK manager ──────────────────────────────────────────────────────

	private async getOrCreateManager(): Promise<any> {
		if (this.sdkManager) return this.sdkManager;
		const { FoundryLocalManager } = await import("foundry-local-sdk");
		// Suppress native core's init log that corrupts the TUI.
		// The log goes to stdout despite logLevel: "fatal".
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

	// ── Model load / unload (in-process) ─────────────────────────────────

	async loadModel(alias: string): Promise<void> {
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!(await model.isLoaded())) {
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
	 * Unload all loaded models and clean up resources.
	 * Call on Pi shutdown to prevent OGA memory leaks.
	 */
	async cleanup(): Promise<void> {
		if (!this.sdkManager) return;
		try {
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
		this.loadedChatClients.clear();
	}

	// ── Streaming inference (native FFI) ─────────────────────────────────

	streamChat(model: Model<any>, context: Context, _options?: SimpleStreamOptions): AssistantMessageEventStream {
		const stream = createAssistantMessageEventStream();

		(async () => {
			const output: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};

			try {
				stream.push({ type: "start", partial: output });

				// Show loading indicator directly via stderr (synchronous) because
				// model.load() is a blocking FFI call that prevents TUI rendering
				const needsLoad = !this.loadedChatClients.has(model.id);
				if (needsLoad) {
					process.stderr.write(`\x1b[33mLoading ${model.id} into memory...\x1b[0m\n`);
				}

				const chatClient = await this.getChatClient(model.id);

				const messages = convertContextToOpenAI(context);
				const tools = context.tools ? convertToolsToOpenAI(context.tools) : undefined;

				let currentTextIndex = -1;
				let textBuffer = "";
				let insideToolCallTag = false;
				const toolCallAccumulators: Map<number, { id: string; name: string; args: string }> = new Map();

				const flushTextBuffer = () => {
					if (!textBuffer) return;
					// Filter out <tool_call> tags and their JSON content
					const cleaned = textBuffer
						.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
						.replace(/<tool_call>[\s\S]*/g, ""); // partial tag at end
					if (cleaned.trim()) {
						if (currentTextIndex === -1) {
							output.content.push({ type: "text", text: "" });
							currentTextIndex = output.content.length - 1;
							stream.push({ type: "text_start", contentIndex: currentTextIndex, partial: output });
						}
						const textBlock = output.content[currentTextIndex];
						if (textBlock.type === "text") {
							textBlock.text += cleaned;
						}
						stream.push({ type: "text_delta", contentIndex: currentTextIndex, delta: cleaned, partial: output });
					}
					textBuffer = "";
				};

				const onChunk = (chunk: any) => {
					const choice = chunk.choices?.[0];
					if (!choice) return;
					const delta = choice.delta;

					if (delta?.content) {
						textBuffer += delta.content;
						// Detect <tool_call> tags — suppress text until </tool_call>
						if (textBuffer.includes("<tool_call>")) {
							insideToolCallTag = true;
						}
						if (insideToolCallTag) {
							if (textBuffer.includes("</tool_call>")) {
								insideToolCallTag = false;
								// Clear the tool call text entirely — the SDK will deliver
								// the parsed tool_calls via delta.tool_calls
								textBuffer = textBuffer.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "");
							}
							// Don't flush while inside a tool call tag
							return;
						}
						flushTextBuffer();
					}

					if (delta?.tool_calls) {
						flushTextBuffer();
						if (currentTextIndex !== -1) {
							const textBlock = output.content[currentTextIndex];
							if (textBlock.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: currentTextIndex,
									content: textBlock.text,
									partial: output,
								});
							}
							currentTextIndex = -1;
						}
						for (const tc of delta.tool_calls) {
							const idx = tc.index ?? 0;
							if (!toolCallAccumulators.has(idx)) {
								toolCallAccumulators.set(idx, {
									id: tc.id ?? `call_${idx}`,
									name: tc.function?.name ?? "",
									args: "",
								});
								output.content.push({
									type: "toolCall",
									id: tc.id ?? `call_${idx}`,
									name: tc.function?.name ?? "",
									arguments: {},
								});
								stream.push({
									type: "toolcall_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							const acc = toolCallAccumulators.get(idx)!;
							if (tc.function?.name) acc.name = tc.function.name;
							if (tc.function?.arguments) {
								acc.args += tc.function.arguments;
								const contentIdx = output.content.findIndex(
									(c) => c.type === "toolCall" && (c as ToolCall).id === acc.id,
								);
								if (contentIdx !== -1) {
									stream.push({
										type: "toolcall_delta",
										contentIndex: contentIdx,
										delta: tc.function.arguments,
										partial: output,
									});
								}
							}
						}
					}

					if (choice.finish_reason) {
						flushTextBuffer();
						if (currentTextIndex !== -1) {
							const textBlock = output.content[currentTextIndex];
							if (textBlock.type === "text") {
								stream.push({
									type: "text_end",
									contentIndex: currentTextIndex,
									content: textBlock.text,
									partial: output,
								});
							}
						}
						for (const [, acc] of toolCallAccumulators) {
							let parsedArgs = {};
							try {
								parsedArgs = JSON.parse(acc.args);
							} catch {
								/* empty */
							}
							const contentIdx = output.content.findIndex(
								(c) => c.type === "toolCall" && (c as ToolCall).id === acc.id,
							);
							if (contentIdx !== -1) {
								const tc = output.content[contentIdx] as ToolCall;
								tc.name = acc.name;
								tc.arguments = parsedArgs;
								stream.push({ type: "toolcall_end", contentIndex: contentIdx, toolCall: tc, partial: output });
							}
						}
						output.stopReason =
							choice.finish_reason === "tool_calls"
								? "toolUse"
								: choice.finish_reason === "length"
									? "length"
									: "stop";
					}

					if (chunk.usage) {
						output.usage.input = chunk.usage.prompt_tokens ?? 0;
						output.usage.output = chunk.usage.completion_tokens ?? 0;
						output.usage.totalTokens = chunk.usage.total_tokens ?? output.usage.input + output.usage.output;
						calculateCost(model, output.usage);
					}
				};

				// SDK uses callback-based streaming: completeStreamingChat(messages, [tools], callback)
				if (tools) {
					await chatClient.completeStreamingChat(messages, tools, onChunk);
				} else {
					await chatClient.completeStreamingChat(messages, onChunk);
				}

				stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
				stream.end(output);
			} catch (error) {
				output.stopReason = "error";
				output.errorMessage = error instanceof Error ? error.message : String(error);
				stream.push({ type: "error", reason: "error", error: output });
				stream.end(output);
			}
		})();

		return stream;
	}

	private async getChatClient(alias: string): Promise<any> {
		if (this.loadedChatClients.has(alias)) return this.loadedChatClients.get(alias)!;
		const manager = await this.getOrCreateManager();
		(manager.catalog as any).lastFetch = 0;
		const model = await manager.catalog.getModel(alias);
		if (!(await model.isLoaded())) await model.load();
		const client = model.createChatClient();
		this.loadedChatClients.set(alias, client);
		return client;
	}

	// ── Pi model mapping ─────────────────────────────────────────────────

	buildPiModels(catalogModels: LocalModelInfo[]): Model<"openai-completions">[] {
		return catalogModels.map((m) => ({
			id: m.alias,
			name: `${m.displayName} (Foundry Local)`,
			api: "openai-completions" as const,
			provider: FOUNDRY_LOCAL_PROVIDER,
			baseUrl: "local://foundry",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: m.contextLength ?? 32768,
			maxTokens: m.maxOutputTokens ?? 4096,
			compat: FOUNDRY_LOCAL_COMPAT,
		}));
	}
}

// ── Context conversion helpers ───────────────────────────────────────────

function convertContextToOpenAI(context: Context): any[] {
	const messages: any[] = [];
	if (context.systemPrompt) {
		messages.push({ role: "system", content: context.systemPrompt });
	}
	for (const msg of context.messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c) => c.type === "text")
							.map((c) => (c as any).text)
							.join("\n");
			messages.push({ role: "user", content: content || "." });
		} else if (msg.role === "assistant") {
			const textParts = msg.content.filter((c) => c.type === "text");
			const toolCalls = msg.content.filter((c) => c.type === "toolCall") as ToolCall[];
			const textContent = textParts.length > 0 ? textParts.map((c) => (c as any).text).join("") : "";
			const assistantMsg: any = {
				role: "assistant",
				content: textContent || ".",
			};
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => ({
					id: tc.id,
					type: "function",
					function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
				}));
			}
			messages.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c) => c.type === "text")
				.map((c) => (c as any).text)
				.join("\n");
			messages.push({
				role: "tool",
				tool_call_id: msg.toolCallId,
				content: content || (msg.isError ? "Error" : "OK"),
			});
		}
	}
	// SDK validation requires every message to have non-empty string content
	// that passes trim() check. Use "." as a minimal non-whitespace placeholder.
	for (const msg of messages) {
		if (!msg.content || (typeof msg.content === "string" && msg.content.trim() === "")) {
			msg.content = ".";
		}
	}
	return messages;
}

function convertToolsToOpenAI(tools: any[]): any[] {
	return tools.map((tool) => ({
		type: "function",
		function: { name: tool.name, description: tool.description, parameters: tool.parameters },
	}));
}
