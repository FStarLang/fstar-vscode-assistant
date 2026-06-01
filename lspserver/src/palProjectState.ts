import * as path from 'path';
import * as cp from 'child_process';
import * as util from 'util';
import { readFile, readdir } from 'fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Diagnostic, Position, Range } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { FStarConfig } from './fstar';
import { FStarDocumentState, DocumentStateEventHandlers } from './documentState';
import { fstarVSCodeAssistantSettings } from './settings';
import { AsyncRateLimiter } from './asyncSignals';

// pal.config.json format
export interface PalConfig {
	pal_exe?: string;
	options?: string[];
	files?: string; // glob pattern like "*.c"
}

// source_range_info.json types (positions are LSP-compatible: 0-based line/character)
export interface PalMapping {
	source: Position;
	pulse: Position;
}

export interface PalModuleInfo {
	fstFile: string;
	declName: string;
	sourceRange: Range;
	mappings: PalMapping[];
}

export interface PalSourceFileInfo {
	uri: string;
	modules: PalModuleInfo[];
}

export interface PalSourceRangeInfo {
	sourceFiles: PalSourceFileInfo[];
}

export interface PalProjectStateEventHandlers {
	sendDiagnostics(uri: string, diagnostics: Diagnostic[]): void;
	sendStatus(uri: string, fragments: any[]): void;
}

export type PalDiagnosticsListener = (fstFile: string, diagnostics: Diagnostic[]) => void;
export type PalStatusListener = (fstFile: string, fragments: any[]) => void;

/**
 * Project-level state for a PAL project. One instance per pal.config.json directory.
 * Manages PAL invocation and shared FStarDocumentState instances for all generated .fst files.
 */
export class PalProjectState {
	private palConfig: PalConfig;
	private projectDir: string;
	private outDir: string;
	private disposed = false;

	// Map from .fst file basename (e.g., "Func_foo.fst") to FStarDocumentState
	private fstStates = new Map<string, FStarDocumentState>();

	// Parsed source range info after last PAL run
	private sourceRangeInfo?: PalSourceRangeInfo;

	// PAL diagnostics keyed by C file URI (normalized to basename)
	private palDiagnostics = new Map<string, Diagnostic[]>();

	// Callbacks registered by CDocumentStates for PAL completion
	private onPalCompleteCallbacks = new Set<() => void>();

	// Listeners for diagnostics/status per .fst file (used by both C and Fst document states)
	private diagnosticsListeners = new Set<PalDiagnosticsListener>();
	private statusListeners = new Set<PalStatusListener>();

	// Callbacks registered by FstDocumentStates for diagnostics/status forwarding
	private fstEventHandlers = new Map<string, DocumentStateEventHandlers>();

	private palRateLimiter = new AsyncRateLimiter(500);

	constructor(
		public readonly configPath: string,
		palConfig: PalConfig,
		private fstarConfig: FStarConfig,
		private globalEventHandlers: DocumentStateEventHandlers,
		private config: fstarVSCodeAssistantSettings,
	) {
		this.palConfig = palConfig;
		this.projectDir = path.dirname(configPath);

		// Determine output directory from options
		const opts = palConfig.options ?? [];
		const outdirIdx = opts.indexOf('--outdir');
		this.outDir = outdirIdx >= 0 && outdirIdx + 1 < opts.length
			? path.resolve(this.projectDir, opts[outdirIdx + 1])
			: this.projectDir;
	}

	get outputDir(): string { return this.outDir; }

	getSourceRangeInfo(): PalSourceRangeInfo | undefined {
		return this.sourceRangeInfo;
	}

	getFstState(fstBasename: string): FStarDocumentState | undefined {
		return this.fstStates.get(fstBasename);
	}

	/** Get all .fst basenames associated with a given C file URI */
	getFstFilesForCFile(cFileUri: string): string[] {
		if (!this.sourceRangeInfo) return [];
		const result: string[] = [];
		for (const sf of this.sourceRangeInfo.sourceFiles) {
			if (this.normalizeCUri(sf.uri) === this.normalizeCUri(cFileUri)) {
				for (const mod of sf.modules) {
					result.push(mod.fstFile);
				}
			}
		}
		return result;
	}

	/** Get PAL-level diagnostics for a C file */
	getPalDiagnosticsForCFile(cFileUri: string): Diagnostic[] {
		return this.palDiagnostics.get(this.normalizeCUri(cFileUri)) ?? [];
	}

	/** Get module infos for a given C file URI */
	getModulesForCFile(cFileUri: string): PalModuleInfo[] {
		if (!this.sourceRangeInfo) return [];
		const result: PalModuleInfo[] = [];
		for (const sf of this.sourceRangeInfo.sourceFiles) {
			if (this.normalizeCUri(sf.uri) === this.normalizeCUri(cFileUri)) {
				result.push(...sf.modules);
			}
		}
		return result;
	}

	private normalizeCUri(uri: string): string {
		// Normalize to just the basename for comparison since PAL URIs might differ
		try {
			return path.basename(URI.parse(uri).fsPath);
		} catch {
			return path.basename(uri);
		}
	}

	/** Register a callback to be called when PAL completes */
	onPalComplete(cb: () => void) {
		this.onPalCompleteCallbacks.add(cb);
	}

	unregisterPalComplete(cb: () => void) {
		this.onPalCompleteCallbacks.delete(cb);
	}

	/** Register event handlers for a specific .fst file (used by PalFstDocumentState) */
	registerFstEventHandlers(fstBasename: string, handlers: DocumentStateEventHandlers) {
		this.fstEventHandlers.set(fstBasename, handlers);
	}

	unregisterFstEventHandlers(fstBasename: string) {
		this.fstEventHandlers.delete(fstBasename);
	}

	/** Register diagnostics listener (used by PalCDocumentState) */
	onDiagnostics(listener: PalDiagnosticsListener) {
		this.diagnosticsListeners.add(listener);
	}
	offDiagnostics(listener: PalDiagnosticsListener) {
		this.diagnosticsListeners.delete(listener);
	}

	/** Register status listener */
	onStatus(listener: PalStatusListener) {
		this.statusListeners.add(listener);
	}
	offStatus(listener: PalStatusListener) {
		this.statusListeners.delete(listener);
	}

	/** Trigger a PAL run (debounced at project level) */
	triggerPal() {
		this.palRateLimiter.fire(async () => {
			if (this.disposed) return;
			await this.runPalCore();
		});
	}

	get palDone(): Promise<void> { return this.palRateLimiter.settled; }

	private async runPalCore() {
		try {
			// Expand file glob
			const filesPattern = this.palConfig.files ?? '*.c';
			const allFiles = await readdir(this.projectDir);
			const cFiles = this.expandGlob(allFiles, filesPattern);

			if (cFiles.length === 0) return;

			const palExe = this.palConfig.pal_exe
				? path.resolve(this.projectDir, this.palConfig.pal_exe)
				: 'pal';

			const args = [...(this.palConfig.options ?? []), ...cFiles];

			await util.promisify(cp.execFile)(palExe, args, {
				cwd: this.projectDir,
				maxBuffer: 50 * 1024 * 1024,
			});
		} catch (e) {
			console.error('PAL invocation failed:', e);
		}

		if (this.disposed) return;

		// Parse source_range_info.json
		try {
			const infoPath = path.join(this.outDir, 'source_range_info.json');
			const content = await readFile(infoPath, 'utf8');
			this.sourceRangeInfo = JSON.parse(content) as PalSourceRangeInfo;
		} catch (e) {
			console.error('Failed to read source_range_info.json:', e);
			this.sourceRangeInfo = undefined;
		}

		// Parse PAL diagnostics (format: Record<uri, Diagnostic[]>)
		this.palDiagnostics.clear();
		try {
			const diagPath = path.join(this.outDir, 'diagnostics.json');
			const content = await readFile(diagPath, 'utf8');
			const parsed = JSON.parse(content) as Record<string, Diagnostic[]>;
			for (const [uri, diags] of Object.entries(parsed)) {
				const key = this.normalizeCUri(uri);
				this.palDiagnostics.set(key, diags);
			}
		} catch {}

		// Refresh FStarDocumentState instances for generated files
		await this.refreshFstStates();

		// Notify all registered C document states
		for (const cb of this.onPalCompleteCallbacks) {
			cb();
		}
	}

	private async refreshFstStates() {
		if (!this.sourceRangeInfo) return;

		// Collect all .fst files mentioned in source range info
		const allFstFiles = new Set<string>();
		for (const sf of this.sourceRangeInfo.sourceFiles) {
			for (const mod of sf.modules) {
				allFstFiles.add(mod.fstFile);
			}
		}

		// For each .fst file, create or update FStarDocumentState
		for (const fstFile of allFstFiles) {
			const fstPath = path.join(this.outDir, fstFile);
			const fstUri = URI.from({ scheme: 'file', path: fstPath }).toString();

			let contents: string;
			try {
				contents = await readFile(fstPath, 'utf8');
			} catch {
				continue; // File doesn't exist yet
			}

			const existingState = this.fstStates.get(fstFile);
			if (existingState) {
				// Update the document content
				const newDoc = TextDocument.create(fstUri, 'fstar', Date.now(), contents);
				existingState.changeDoc(newDoc);
			} else {
				// Create new FStarDocumentState
				const doc = TextDocument.create(fstUri, 'fstar', Date.now(), contents);

				const eventHandlers: DocumentStateEventHandlers = {
					sendDiagnostics: (params) => {
						// Forward to the fst tab if open
						const fstHandlers = this.fstEventHandlers.get(fstFile);
						if (fstHandlers) {
							fstHandlers.sendDiagnostics(params);
						}
						// Notify diagnostics listeners (C document states)
						for (const listener of this.diagnosticsListeners) {
							listener(fstFile, params.diagnostics);
						}
					},
					sendStatus: (params) => {
						const fstHandlers = this.fstEventHandlers.get(fstFile);
						if (fstHandlers) {
							fstHandlers.sendStatus(params);
						}
						// Notify status listeners
						for (const listener of this.statusListeners) {
							listener(fstFile, params.fragments);
						}
					},
				};

				const state = FStarDocumentState.make(doc, this.fstarConfig, eventHandlers, this.config);
				if (state) {
					this.fstStates.set(fstFile, state);
				}
			}
		}

		// Dispose states for .fst files no longer in source range info
		for (const [fstFile, state] of this.fstStates) {
			if (!allFstFiles.has(fstFile)) {
				state.dispose();
				this.fstStates.delete(fstFile);
			}
		}
	}

	/** Expand a simple glob pattern (only supports *.ext) against a list of filenames */
	private expandGlob(files: string[], pattern: string): string[] {
		if (pattern.startsWith('*')) {
			const ext = pattern.slice(1); // e.g., ".c"
			return files.filter(f => f.endsWith(ext));
		}
		// Fallback: treat as literal
		return files.filter(f => f === pattern);
	}

	/** Check if a file path is inside this project's output directory */
	isInOutputDir(filePath: string): boolean {
		const rel = path.relative(this.outDir, filePath);
		return !rel.startsWith('..') && !path.isAbsolute(rel);
	}

	dispose() {
		this.disposed = true;
		for (const state of this.fstStates.values()) {
			state.dispose();
		}
		this.fstStates.clear();
		this.onPalCompleteCallbacks.clear();
		this.fstEventHandlers.clear();
	}

	/** Attempt to read and parse pal.config.json from a directory */
	static async tryLoad(dir: string, fstarConfig: FStarConfig, eventHandlers: DocumentStateEventHandlers, config: fstarVSCodeAssistantSettings): Promise<PalProjectState | undefined> {
		const configPath = path.join(dir, 'pal.config.json');
		try {
			const content = await readFile(configPath, 'utf8');
			const palConfig = JSON.parse(content) as PalConfig;
			if (palConfig.pal_exe) {
				palConfig.pal_exe = path.resolve(dir, palConfig.pal_exe);
			}
			return new PalProjectState(configPath, palConfig, fstarConfig, eventHandlers, config);
		} catch {
			return undefined;
		}
	}
}
