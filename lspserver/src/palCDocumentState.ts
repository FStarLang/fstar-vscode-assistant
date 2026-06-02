import { Position, Range, TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentState, DocumentStateEventHandlers } from './documentState';
import { TextDocumentPositionParams, CompletionItem, Hover, DefinitionParams, LocationLink, DocumentRangeFormattingParams, TextEdit, Diagnostic } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { PalProjectState, PalModuleInfo, PalMapping, PalDiagnosticsListener, PalStatusListener } from './palProjectState';
import { FragmentStatus } from './fstarLspExtensions';
import * as path from 'path';

function posLe(a: Position, b: Position): boolean {
	return a.line < b.line || (a.line === b.line && a.character <= b.character);
}

/**
 * Document state for a C file in a PAL project.
 * Triggers PAL via the project state and aggregates diagnostics from all associated F* modules.
 */
export class PalCDocumentState implements DocumentState {
	private cUri: string;
	private cPath: string;
	private disposed = false;
	private onPalCompleteBound: () => void;
	private diagnosticsListener: PalDiagnosticsListener;
	private statusListener: PalStatusListener;

	// Cached diagnostics per fst file for aggregation
	private fstDiagnostics = new Map<string, Diagnostic[]>();
	private fstStatusFragments = new Map<string, FragmentStatus[]>();

	constructor(
		private currentDoc: TextDocument,
		private projectState: PalProjectState,
		private cEvents: DocumentStateEventHandlers,
	) {
		this.cUri = currentDoc.uri;
		this.cPath = URI.parse(currentDoc.uri).fsPath;

		this.onPalCompleteBound = () => this.onPalComplete();
		this.projectState.onPalComplete(this.onPalCompleteBound);

		this.diagnosticsListener = (fstFile, diagnostics) => {
			if (this.disposed) return;
			if (!this.isMyFstFile(fstFile)) return;
			this.fstDiagnostics.set(fstFile, diagnostics);
			this.sendAggregatedDiagnostics();
		};
		this.statusListener = (fstFile, fragments) => {
			if (this.disposed) return;
			if (!this.isMyFstFile(fstFile)) return;
			this.fstStatusFragments.set(fstFile, fragments);
			this.sendAggregatedStatus();
		};

		this.projectState.onDiagnostics(this.diagnosticsListener);
		this.projectState.onStatus(this.statusListener);

		// Trigger initial PAL run
		this.projectState.triggerPal();
	}

	private isMyFstFile(fstFile: string): boolean {
		const myFiles = this.projectState.getFstFilesForCFile(this.cUri);
		return myFiles.includes(fstFile);
	}

	private onPalComplete() {
		if (this.disposed) return;
		// Reset cached diagnostics since files were regenerated
		this.fstDiagnostics.clear();
		this.fstStatusFragments.clear();
		this.sendAggregatedDiagnostics();
		this.sendAggregatedStatus();
	}

	dispose(): void {
		this.disposed = true;
		this.projectState.unregisterPalComplete(this.onPalCompleteBound);
		this.projectState.offDiagnostics(this.diagnosticsListener);
		this.projectState.offStatus(this.statusListener);
		this.cEvents.sendDiagnostics({ uri: this.cUri, diagnostics: [] });
		this.cEvents.sendStatus({ uri: this.cUri, fragments: [] });
	}

	setDebug(debug: boolean): void {
		const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
		for (const fstFile of fstFiles) {
			this.projectState.getFstState(fstFile)?.setDebug(debug);
		}
	}

	changeDoc(newDoc: TextDocument): void {
		this.currentDoc = newDoc;
		// PAL reads from disk, so we don't trigger on content change.
		// PAL is triggered on save via onSave().

		// Invalidate status since the source has changed and verification is stale.
		this.fstDiagnostics.clear();
		this.fstStatusFragments.clear();
		this.cEvents.sendStatus({ uri: this.cUri, fragments: [] });
	}

	/** Called when the C file is saved to disk */
	onSave(): void {
		this.projectState.triggerPal();
	}

	verifyAll(params?: { flycheckOnly?: boolean }): void {
		void this.projectState.palDone.then(async () => {
			const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
			for (const fstFile of fstFiles) {
				const state = await this.projectState.getOrCreateFstState(fstFile);
				state?.verifyAll(params);
			}
		});
	}

	verifyToPosition(position: Position): void {
		void this.projectState.palDone.then(async () => {
			const mapped = this.c2fst(position);
			if (mapped) {
				// Verify the entire F* file corresponding to this position
				const state = await this.projectState.getOrCreateFstState(mapped.fstFile);
				state?.verifyAll();
			}
		});
	}

	laxToPosition(position: Position): void {
		void this.projectState.palDone.then(async () => {
			const mapped = this.c2fst(position);
			if (mapped) {
				const state = await this.projectState.getOrCreateFstState(mapped.fstFile);
				state?.laxToPosition(mapped.position);
			}
		});
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async onCompletion(_textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		return;
	}

	async onHover(pos: TextDocumentPositionParams): Promise<Hover | undefined> {
		await this.projectState.palDone;
		const mapped = this.c2fst(pos.position);
		if (!mapped) return;

		const state = this.projectState.getFstState(mapped.fstFile);
		if (!state) return;

		const fstUri = URI.from({ scheme: 'file', path: path.join(this.projectState.outputDir, mapped.fstFile) }).toString();
		const hover = await state.onHover({
			textDocument: { uri: fstUri },
			position: mapped.position,
		});
		if (!hover) return;
		return {
			...hover,
			range: hover.range ? this.fst2cRange(mapped.fstFile, hover.range) : undefined,
		};
	}

	async onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined> {
		await this.projectState.palDone;
		const mapped = this.c2fst(defParams.position);
		if (!mapped) return;

		const state = this.projectState.getFstState(mapped.fstFile);
		if (!state) return;

		const fstUri = URI.from({ scheme: 'file', path: path.join(this.projectState.outputDir, mapped.fstFile) }).toString();
		return state.onDefinition({
			textDocument: { uri: fstUri },
			position: mapped.position,
		});
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async onDocumentRangeFormatting(_formatParams: DocumentRangeFormattingParams): Promise<TextEdit[]> {
		return [];
	}

	async killAndRestartSolver(): Promise<void> {
		const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
		for (const fstFile of fstFiles) {
			await this.projectState.getFstState(fstFile)?.killAndRestartSolver();
		}
	}

	async getTranslatedFst(position: Position): Promise<{ uri: string, position: Position } | undefined> {
		await this.projectState.palDone;
		const mapped = this.c2fst(position);
		if (!mapped) return;
		const fstPath = path.join(this.projectState.outputDir, mapped.fstFile);
		const fstUri = URI.from({ scheme: 'file', path: fstPath }).toString();
		return { uri: fstUri, position: mapped.position };
	}

	// --- Position mapping ---

	private c2fst(pos: Position): { fstFile: string; position: Position } | undefined {
		const modules = this.projectState.getModulesForCFile(this.cUri);

		// Find the module whose sourceRange contains this position
		let bestModule: PalModuleInfo | undefined;
		for (const mod of modules) {
			if (posLe(mod.sourceRange.start, pos) && posLe(pos, mod.sourceRange.end)) {
				bestModule = mod;
				break;
			}
		}

		if (!bestModule) {
			// Find the closest module whose range starts before this position
			for (const mod of modules) {
				if (posLe(mod.sourceRange.start, pos)) {
					bestModule = mod;
				}
			}
		}

		if (!bestModule) {
			if (modules.length > 0) bestModule = modules[0];
			else return undefined;
		}

		return { fstFile: bestModule.fstFile, position: this.mapCToPulse(pos, bestModule.mappings) };
	}

	private mapCToPulse(pos: Position, mappings: PalMapping[]): Position {
		let best: PalMapping | undefined;
		for (const m of mappings) {
			if (posLe(m.source, pos)) {
				if (!best || posLe(best.source, m.source)) {
					best = m;
				}
			}
		}
		return best ? best.pulse : { line: 0, character: 0 };
	}

	private fst2cRange(fstFile: string, range: Range): Range {
		const modules = this.projectState.getModulesForCFile(this.cUri);
		const mod = modules.find(m => m.fstFile === fstFile);
		if (!mod) return range;

		const startPos = this.mapPulseToC(range.start, mod.mappings);
		const endPos = this.mapPulseToC(range.end, mod.mappings);
		return { start: startPos, end: endPos };
	}

	private mapPulseToC(pos: Position, mappings: PalMapping[]): Position {
		let best: PalMapping | undefined;
		for (const m of mappings) {
			if (posLe(m.pulse, pos)) {
				if (!best || posLe(best.pulse, m.pulse)) {
					best = m;
				}
			}
		}
		return best ? best.source : { line: 0, character: 0 };
	}

	// --- Diagnostics/Status aggregation ---

	private sendAggregatedDiagnostics() {
		const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
		const allDiags: Diagnostic[] = [];

		for (const fstFile of fstFiles) {
			const diags = this.fstDiagnostics.get(fstFile) ?? [];
			for (const diag of diags) {
				allDiags.push({
					...diag,
					range: this.fst2cRange(fstFile, diag.range),
				});
			}
		}

		// Add PAL-level diagnostics (already in C source positions)
		const palDiags = this.projectState.getPalDiagnosticsForCFile(this.cUri);
		allDiags.push(...palDiags.map(d => ({ ...d, source: 'PAL' })));

		this.cEvents.sendDiagnostics({ uri: this.cUri, diagnostics: allDiags });
	}

	private sendAggregatedStatus() {
		const modules = this.projectState.getModulesForCFile(this.cUri);
		const allFragments: FragmentStatus[] = [];

		for (const mod of modules) {
			const fragments = this.fstStatusFragments.get(mod.fstFile) ?? [];
			// Summarize the F* file's status into one fragment for the module's sourceRange
			const kind = this.summarizeStatus(fragments);
			if (kind) {
				allFragments.push({ kind, range: mod.sourceRange });
			}
		}

		this.cEvents.sendStatus({ uri: this.cUri, fragments: allFragments });
	}

	/** Summarize multiple F* status fragments into one overall status kind */
	private summarizeStatus(fragments: FragmentStatus[]): FragmentStatus['kind'] | undefined {
		if (fragments.length === 0) return undefined;

		let hasInProgress = false;
		let hasStarted = false;
		let hasFailed = false;
		let hasOk = false;
		let hasLaxOk = false;

		for (const frag of fragments) {
			switch (frag.kind) {
				case 'in-progress': hasInProgress = true; break;
				case 'started': hasStarted = true; break;
				case 'failed':
				case 'light-failed': hasFailed = true; break;
				case 'ok': hasOk = true; break;
				case 'lax-ok':
				case 'light-ok': hasLaxOk = true; break;
			}
		}

		if (hasFailed) return 'failed';
		if (hasInProgress || hasStarted) return 'in-progress';
		if (hasOk && !hasLaxOk) return 'ok';
		if (hasLaxOk) return 'lax-ok';
		return undefined;
	}
}
