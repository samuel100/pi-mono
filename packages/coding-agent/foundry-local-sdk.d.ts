declare module "foundry-local-sdk" {
	export interface FoundryLocalConfig {
		appName: string;
		appDataDir?: string;
		logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
		modelCacheDir?: string;
		logsDir?: string;
		libraryPath?: string;
		serviceEndpoint?: string;
		webServiceUrls?: string[];
	}

	export interface ModelInfo {
		id: string;
		name: string;
		alias: string;
		displayName?: string | null;
		fileSizeMb?: number | null;
		supportsToolCalling?: boolean | null;
		maxOutputTokens?: number | null;
		contextLength?: number | null;
	}

	export interface IModel {
		readonly id: string;
		readonly alias: string;
		readonly info: ModelInfo;
		readonly isCached: boolean;
		readonly contextLength: number | null;
		readonly supportsToolCalling: boolean | null;
		readonly variants: IModel[];

		isLoaded(): Promise<boolean>;
		download(progressCallback?: (progress: number) => void): Promise<void>;
		load(): Promise<void>;
		unload(): Promise<void>;
		removeFromCache(): void;
		selectVariant(variant: IModel): void;
	}

	export class Catalog {
		invalidateCache(): void;
		getModels(): Promise<IModel[]>;
		getModel(alias: string): Promise<IModel>;
		getCachedModels(): Promise<IModel[]>;
		getLoadedModels(): Promise<IModel[]>;
	}

	export class FoundryLocalManager {
		static create(config: FoundryLocalConfig): FoundryLocalManager;
		readonly catalog: Catalog;
		readonly urls: string[];
		readonly isWebServiceRunning: boolean;
		startWebService(): void;
		stopWebService(): void;
	}
}
