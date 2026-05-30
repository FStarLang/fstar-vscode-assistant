import { Position, Range, TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentState, DocumentStateEventHandlers } from './documentState';
import { TextDocumentPositionParams, CompletionItem, Hover, DefinitionParams, LocationLink, DocumentRangeFormattingParams, TextEdit, Diagnostic } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { PalProjectState, PalModuleInfo, PalMapping, PalSourcePos, PalDiagnosticsListener, PalStatusListener } from './palProjectState';
import { FragmentStatus } from './fstarLspExtensions';
import * as path from 'path';

function palPosToLspPos(p: PalSourcePos): Position {
	return { line: p.line, character: p.character };
}

function lspPosToPalPos(p: Position): PalSourcePos {
	return { line: p.line, character: p.character };
}

function palPosLe(a: PalSourcePos, b: PalSourcePos): boolean {
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
		void this.projectState.palDone.then(() => {
			const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
			for (const fstFile of fstFiles) {
				this.projectState.getFstState(fstFile)?.verifyAll(params);
			}
		});
	}

	verifyToPosition(position: Position): void {
		void this.projectState.palDone.then(() => {
			const mapped = this.c2fst(position);
			if (mapped) {
				this.projectState.getFstState(mapped.fstFile)?.verifyToPosition(mapped.position);
			}
		});
	}

	laxToPosition(position: Position): void {
		void this.projectState.palDone.then(() => {
			const mapped = this.c2fst(position);
			if (mapped) {
				this.projectState.getFstState(mapped.fstFile)?.laxToPosition(mapped.position);
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
		const palPos = lspPosToPalPos(pos);

		// Find the module whose sourceRange contains this position
		let bestModule: PalModuleInfo | undefined;
		for (const mod of modules) {
			if (palPosLe(mod.sourceRange.start, palPos) && palPosLe(palPos, mod.sourceRange.end)) {
				bestModule = mod;
				break;
			}
		}

		if (!bestModule) {
			// Find the closest module whose range starts before this position
			for (const mod of modules) {
				if (palPosLe(mod.sourceRange.start, palPos)) {
					bestModule = mod;
				}
			}
		}

		if (!bestModule) {
			if (modules.length > 0) bestModule = modules[0];
			else return undefined;
		}

		const fstPos = this.mapCToPulse(palPos, bestModule.mappings);
		return { fstFile: bestModule.fstFile, position: palPosToLspPos(fstPos) };
	}

	private mapCToPulse(pos: PalSourcePos, mappings: PalMapping[]): PalSourcePos {
		let best: PalMapping | undefined;
		for (const m of mappings) {
			if (palPosLe(m.source, pos)) {
				if (!best || palPosLe(best.source, m.source)) {
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

		const startPos = this.mapPulseToC(lspPosToPalPos(range.start), mod.mappings);
		const endPos = this.mapPulseToC(lspPosToPalPos(range.end), mod.mappings);
		return { start: palPosToLspPos(startPos), end: palPosToLspPos(endPos) };
	}

	private mapPulseToC(pos: PalSourcePos, mappings: PalMapping[]): PalSourcePos {
		let best: PalMapping | undefined;
		for (const m of mappings) {
			if (palPosLe(m.pulse, pos)) {
				if (!best || palPosLe(best.pulse, m.pulse)) {
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
		const fstFiles = this.projectState.getFstFilesForCFile(this.cUri);
		const allFragments: FragmentStatus[] = [];

		for (const fstFile of fstFiles) {
			const fragments = this.fstStatusFragments.get(fstFile) ?? [];
			for (const frag of fragments) {
				allFragments.push({
					...frag,
					range: this.fst2cRange(fstFile, frag.range),
				});
			}
		}

		this.cEvents.sendStatus({ uri: this.cUri, fragments: allFragments });
	}
}
