import { type Model, modelsAreEqual } from "@mariozechner/pi-ai";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@mariozechner/pi-tui";
import { FOUNDRY_LOCAL_PROVIDER, type LocalModelInfo } from "../../../core/foundry-local-provider.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import type { SettingsManager } from "../../../core/settings-manager.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint } from "./keybinding-hints.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
	/** For Foundry Local models: cached/uncached state and size info */
	localInfo?: LocalModelInfo;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

type ModelScope = "all" | "scoped";

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private currentModel?: Model<any>;
	private settingsManager: SettingsManager;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private errorMessage?: string;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private statusText?: Text;
	private downloading: boolean = false;
	private localModelInfoMap: Map<string, LocalModelInfo> = new Map();
	private loadedLocalModels: Set<string> = new Set();

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		settingsManager: SettingsManager,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.currentModel = currentModel;
		this.settingsManager = settingsManager;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.addChild(this.scopeText);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
			this.addChild(this.scopeHintText);
		} else {
			const hintText = "Only showing models with configured API keys (see README for details)";
			this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		}
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			if (this.filteredModels[this.selectedIndex]) {
				this.handleSelect(this.filteredModels[this.selectedIndex].model);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Load models and do initial render
		this.loadModels().then(() => {
			if (initialSearchInput) {
				this.filterModels(initialSearchInput);
			} else {
				this.updateList();
			}
			// Request re-render after models are loaded
			this.tui.requestRender();
		});
	}

	private async loadModels(): Promise<void> {
		let models: ModelItem[];

		// Refresh to pick up any changes to models.json
		this.modelRegistry.refresh();

		// Check for models.json errors
		const loadError = this.modelRegistry.getError();
		if (loadError) {
			this.errorMessage = loadError;
		}

		// Load available models (built-in models still work even if models.json failed)
		try {
			const availableModels = await this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		// Load Foundry Local catalog models with download state
		try {
			const fl = this.modelRegistry.foundryLocal;
			if (fl.isAvailable()) {
				const catalogModels = await fl.getCatalogModels();
				this.localModelInfoMap.clear();
				for (const info of catalogModels) {
					this.localModelInfoMap.set(info.alias, info);
				}

				// Query which models are currently loaded on the service
				this.loadedLocalModels = new Set(await fl.listLoadedModels());

				// Attach localInfo to any Foundry Local models already in the list
				for (const item of models) {
					if (item.provider === FOUNDRY_LOCAL_PROVIDER) {
						item.localInfo = this.localModelInfoMap.get(item.id);
					}
				}
				// Add catalog models not yet registered (uncached models from full catalog)
				const registeredIds = new Set(models.filter((m) => m.provider === FOUNDRY_LOCAL_PROVIDER).map((m) => m.id));
				for (const info of catalogModels) {
					if (!registeredIds.has(info.alias)) {
						const piModels = fl.buildPiModels([info], fl.getBaseUrl() ?? "http://127.0.0.1:5273");
						if (piModels.length > 0) {
							models.push({
								provider: FOUNDRY_LOCAL_PROVIDER,
								id: info.alias,
								model: piModels[0],
								localInfo: info,
							});
						}
					}
				}
			}
		} catch {
			// Foundry Local catalog unavailable — continue with cloud models only
		}

		this.allModels = this.sortModels(models);
		this.scopedModels = this.scopedModels.map((scoped) => {
			const refreshed = this.modelRegistry.find(scoped.model.provider, scoped.model.id);
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.sortModels(
			this.scopedModels.map((scoped) => ({
				provider: scoped.model.provider,
				id: scoped.model.id,
				model: scoped.model,
			})),
		);
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		// Sort priority: current model > loaded local > cached local > cloud models > uncached local
		sorted.sort((a, b) => {
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;

			const aIsLocal = a.provider === FOUNDRY_LOCAL_PROVIDER;
			const bIsLocal = b.provider === FOUNDRY_LOCAL_PROVIDER;

			// Local models with cache state sort above uncached local models
			if (aIsLocal && bIsLocal) {
				const aLoaded = this.loadedLocalModels.has(a.id);
				const bLoaded = this.loadedLocalModels.has(b.id);
				if (aLoaded && !bLoaded) return -1;
				if (!aLoaded && bLoaded) return 1;

				const aCached = a.localInfo?.isCached ?? false;
				const bCached = b.localInfo?.isCached ?? false;
				if (aCached && !bCached) return -1;
				if (!aCached && bCached) return 1;

				return a.id.localeCompare(b.id);
			}

			// Cached local models sort above cloud models; uncached sort below
			if (aIsLocal && !bIsLocal) {
				return a.localInfo?.isCached || this.loadedLocalModels.has(a.id) ? -1 : 1;
			}
			if (!aIsLocal && bIsLocal) {
				return b.localInfo?.isCached || this.loadedLocalModels.has(b.id) ? 1 : -1;
			}

			return a.provider.localeCompare(b.provider);
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("tui.input.tab", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.selectedIndex = 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		this.filteredModels = query
			? fuzzyFilter(
					this.activeModels,
					query,
					({ id, provider }) => `${id} ${provider} ${provider}/${id} ${provider} ${id}`,
				)
			: this.activeModels;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isLocal = item.provider === FOUNDRY_LOCAL_PROVIDER;
			const localInfo = item.localInfo;

			// Build status suffix for local models
			let statusSuffix = "";
			if (isLocal && localInfo) {
				if (this.loadedLocalModels.has(item.id)) {
					statusSuffix = theme.fg("success", " ✓ loaded");
				} else if (localInfo.isCached) {
					statusSuffix = theme.fg("success", " ● cached");
				} else {
					statusSuffix = theme.fg("warning", " ⬇");
				}
			} else if (isCurrent) {
				statusSuffix = theme.fg("success", " ✓");
			}

			let line = "";
			if (isSelected) {
				const prefix = theme.fg("accent", "→ ");
				const modelText = `${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				line = `${prefix + theme.fg("accent", modelText)} ${providerBadge}${statusSuffix}`;
			} else {
				const modelText = `  ${item.id}`;
				const providerBadge = theme.fg("muted", `[${item.provider}]`);
				line = `${modelText} ${providerBadge}${statusSuffix}`;
			}

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.model.name}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel.model);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		const selectedItem = this.filteredModels[this.selectedIndex];
		const isLocal = model.provider === FOUNDRY_LOCAL_PROVIDER;
		const localInfo = selectedItem?.localInfo;

		// For uncached Foundry Local models, download and load first
		if (isLocal && localInfo && !localInfo.isCached) {
			if (this.downloading) return; // Prevent double-click
			this.downloading = true;
			this.setStatusText(`Downloading ${model.id}...`);
			this.tui.requestRender();

			const fl = this.modelRegistry.foundryLocal;

			(async () => {
				try {
					// Ensure service is running
					await fl.ensureServiceRunning();

					// Download with progress
					await fl.downloadModel(model.id, (percent: number) => {
						this.setStatusText(`Downloading ${model.id}... ${percent.toFixed(0)}%`);
						this.tui.requestRender();
					});

					// Load model on the service
					this.setStatusText(`Loading ${model.id}...`);
					this.tui.requestRender();
					await fl.loadModel(model.id);

					// Update local info cache
					if (localInfo) localInfo.isCached = true;

					// Register model in registry and select it
					const baseUrl = fl.getBaseUrl() ?? "http://127.0.0.1:5273";
					const piModels = fl.buildPiModels([localInfo], baseUrl);
					if (piModels.length > 0) {
						this.modelRegistry.setFoundryLocalModels(piModels);
						const registeredModel = this.modelRegistry.find(FOUNDRY_LOCAL_PROVIDER, model.id);
						if (registeredModel) {
							this.settingsManager.setDefaultModelAndProvider(registeredModel.provider, registeredModel.id);
							this.onSelectCallback(registeredModel);
						}
					}
				} catch (error) {
					this.setStatusText(
						theme.fg("error", `Failed: ${error instanceof Error ? error.message : String(error)}`),
					);
					this.tui.requestRender();
				} finally {
					this.downloading = false;
				}
			})();
			return;
		}

		// For cached local models, ensure loaded on service
		if (isLocal) {
			const fl = this.modelRegistry.foundryLocal;
			(async () => {
				try {
					const baseUrl = await fl.ensureServiceRunning();
					this.setStatusText(`Loading ${model.id}...`);
					this.tui.requestRender();
					await fl.loadModel(model.id);

					// Update model baseUrl to match running service
					const updatedModel = { ...model, baseUrl: `${baseUrl}/v1` };
					this.settingsManager.setDefaultModelAndProvider(updatedModel.provider, updatedModel.id);
					this.onSelectCallback(updatedModel);
				} catch (error) {
					this.setStatusText(
						theme.fg("error", `Failed: ${error instanceof Error ? error.message : String(error)}`),
					);
					this.tui.requestRender();
				}
			})();
			return;
		}

		// Cloud models — immediate selection
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.onSelectCallback(model);
	}

	private setStatusText(text: string): void {
		if (!this.statusText) {
			this.statusText = new Text(text, 0, 0);
			this.listContainer.addChild(this.statusText);
		} else {
			this.statusText.setText(text);
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
