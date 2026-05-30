import { Position, TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentState, DocumentStateEventHandlers, FStarDocumentState } from './documentState';
import { TextDocumentPositionParams, CompletionItem, Hover, DefinitionParams, LocationLink, DocumentRangeFormattingParams, TextEdit } from 'vscode-languageserver';
import { PalProjectState } from './palProjectState';
import * as path from 'path';

/**
 * Thin DocumentState wrapper for .fst files that belong to a PAL output directory.
 * Shares the FStarDocumentState from PalProjectState.
 * Diagnostics/status are forwarded directly (no position mapping needed).
 */
export class PalFstDocumentState implements DocumentState {
	private fstBasename: string;
	private disposed = false;

	constructor(
		private currentDoc: TextDocument,
		private projectState: PalProjectState,
		private events: DocumentStateEventHandlers,
	) {
		const filePath = new URL(currentDoc.uri).pathname;
		this.fstBasename = path.basename(filePath);

		// Register to receive diagnostics/status for this .fst file
		this.projectState.registerFstEventHandlers(this.fstBasename, this.events);
	}

	private get fstarState(): FStarDocumentState | undefined {
		return this.projectState.getFstState(this.fstBasename);
	}

	dispose(): void {
		this.disposed = true;
		this.projectState.unregisterFstEventHandlers(this.fstBasename);
		this.events.sendDiagnostics({ uri: this.currentDoc.uri, diagnostics: [] });
		this.events.sendStatus({ uri: this.currentDoc.uri, fragments: [] });
	}

	setDebug(debug: boolean): void {
		this.fstarState?.setDebug(debug);
	}

	changeDoc(newDoc: TextDocument): void {
		this.currentDoc = newDoc;
		// Forward the content change to the shared F* state
		this.fstarState?.changeDoc(newDoc);
	}

	verifyAll(params?: { flycheckOnly?: boolean }): void {
		this.fstarState?.verifyAll(params);
	}

	verifyToPosition(position: Position): void {
		this.fstarState?.verifyToPosition(position);
	}

	laxToPosition(position: Position): void {
		this.fstarState?.laxToPosition(position);
	}

	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		return this.fstarState?.onCompletion(textDocumentPosition);
	}

	async onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> {
		return this.fstarState?.onHover(textDocumentPosition);
	}

	async onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined> {
		return this.fstarState?.onDefinition(defParams);
	}

	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams): Promise<TextEdit[]> {
		return this.fstarState?.onDocumentRangeFormatting(formatParams) ?? [];
	}

	async killAndRestartSolver(): Promise<void> {
		return this.fstarState?.killAndRestartSolver();
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async getTranslatedFst(_position: Position): Promise<{ uri: string, position: Position } | undefined> {
		return undefined; // Already an F* file
	}
}
