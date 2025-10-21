import { Position, TextDocument } from 'vscode-languageserver-textdocument';
import { FStarRange, FullBufferQuery, FullBufferQueryResponse, IdeDiagnostic, IdeProgress, IdeProofState } from './fstar_messages';
import { CompletionItem, CompletionItemKind, DefinitionParams, Diagnostic, DiagnosticSeverity, DocumentRangeFormattingParams, Hover, LocationLink, PublishDiagnosticsParams, Range, TextDocumentPositionParams, TextEdit } from 'vscode-languageserver';
import { formatIdeProofState, fstarPosLe, fstarRangeAsRange, mkPosition, posAsFStarPos, posLe, rangeAsFStarRange } from './utils';
import { FragmentStatus, StatusNotificationParams } from './fstarLspExtensions';
import { FStar, FStarConfig } from './fstar';
import { FStarConnection } from './fstar_connection';
import { Debouncer, RateLimiter } from './signals';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as util from 'util';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { fstarVSCodeAssistantSettings } from './settings';

	
interface WordAndRange {
	word: string;
	range: FStarRange;
}
// Find the word at the given position in the given document
// (used to find the symbol under the cursor)
function findWordAtPosition(doc: TextDocument, position: Position): WordAndRange {
	const text = doc.getText();
	const offset = doc.offsetAt(position);
	let start = text.lastIndexOf(' ', offset) + 1;
	const notIdentCharRegex = /[^a-zA-Z_.'0-9]/;
	for (let i = offset; i >= start; i--) {
		if (text.at(i)?.search(notIdentCharRegex) === 0) {
			start = i + 1;
			break;
		}
	}
	const end = text.substring(offset).search(notIdentCharRegex);
	const word = text.substring(start, end >= 0 ? end + offset : undefined);
	const range = Range.create(doc.positionAt(start), doc.positionAt(start + word.length));
	return { word: word, range: rangeAsFStarRange(range) };
}

export interface DocumentStateEventHandlers {
	sendDiagnostics(params: PublishDiagnosticsParams): void;
	sendStatus(params: StatusNotificationParams): void;
}

export interface DocumentState {
	dispose(): void;
	setDebug(debug: boolean): void;
	changeDoc(newDoc: TextDocument): void;
	verifyAll(params?: {flycheckOnly?: boolean}): void;
	verifyToPosition(position: Position): void;
	laxToPosition(position: Position): void;
	onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined>;
	onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined>;
	onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined>;
	onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams): Promise<TextEdit[]>;
	getTranslatedFst(position: Position): Promise<{ uri: string, position: Position } | undefined>;
	killAndRestartSolver(): Promise<void>;
}

export class FStarDocumentState implements DocumentState {
	uri: string;

	// The main fstar.exe process for verifying the current document
	fstar: DocumentProcess;

	// The fstar.exe process for quickly handling on-change events, symbol lookup etc
	// If flycheck is disabled, then we don't spawn the second process and this field is undefined.
	fstar_lax?: DocumentProcess;

	private disposed = false;

	constructor(currentDoc: TextDocument,
			public fstarConfig: FStarConfig,
			public events: DocumentStateEventHandlers,
			fstar: FStarConnection,
			fstar_lax?: FStarConnection) {
		this.uri = currentDoc.uri;
		this.fstar = new DocumentProcess(currentDoc, fstarConfig, this, false, fstar);
		this.fstar_lax = fstar_lax && new DocumentProcess(currentDoc, fstarConfig, this, true, fstar_lax);
	}

	static make(currentDoc: TextDocument, fstarConfig: FStarConfig,
			events: DocumentStateEventHandlers,
			config: fstarVSCodeAssistantSettings):
			FStarDocumentState | undefined {
		const filePath = URI.parse(currentDoc.uri).fsPath;
		const fstar = FStarConnection.tryCreateFStarConnection(fstarConfig, filePath, config.debug);
		if (!fstar) return;
		const fstarLax = config.flyCheck
			?  FStarConnection.tryCreateFStarConnection(fstarConfig, filePath, config.debug, 'lax')
			: undefined;
		return new FStarDocumentState(currentDoc, fstarConfig, events, fstar, fstarLax);
	}

	setDebug(debug: boolean): void {
		this.fstar.fstar.debug = debug;
		if (this.fstar_lax) this.fstar_lax.fstar.debug = debug;
	}

	dispose() {
		this.disposed = true;
		this.fstar.dispose();
		this.fstar_lax?.dispose();

		// Clear all diagnostics for a document when it is closed
		this.events.sendDiagnostics({
			uri: this.uri,
			diagnostics: [],
		});
		this.events.sendStatus({
			uri: this.uri,
			fragments: [],
		});
	}

	changeDoc(newDoc: TextDocument) {
		this.fstar.changeDoc(newDoc);
		this.fstar_lax?.changeDoc(newDoc);
	}

	// Lookup the proof state table for the line at the cursor
	findIdeProofStateAtLine(position: Position) {
		return this.fstar.findIdeProofStateAtLine(position);
	}

	verifyAll(params?: { flycheckOnly?: boolean }) {
		if (!params?.flycheckOnly) this.fstar.validateFStarDocument('full');
		this.fstar_lax?.validateFStarDocument('lax');
	}

	verifyToPosition(position: Position) {
		this.fstar.validateFStarDocumentToPosition('verify-to-position', position);
		this.fstar_lax?.validateFStarDocument('lax');
	}

	laxToPosition(position: Position) {
		this.fstar.validateFStarDocumentToPosition('lax-to-position', position);
		this.fstar_lax?.validateFStarDocument('lax');
	}

	async getTranslatedFst(position: Position): Promise<undefined> {}

	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		return (this.fstar_lax ?? this.fstar).onCompletion(textDocumentPosition);
	}

	async onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> {
		// First, check if we have proof state information for this line
		// This always needs to be routed to the full checking process.
		const proofState = this.fstar.findIdeProofStateAtLine(textDocumentPosition.position);
		if (proofState) {
			return {
				contents: {
					kind: 'markdown',
					value: formatIdeProofState(proofState)
				}
			};
		}

		// Otherwise, check the symbol information for this symbol
		return (this.fstar_lax ?? this.fstar).onHover(textDocumentPosition);
	}

	// The onDefinition handler is called when the user clicks on a symbol
	// It's very similar to the onHover handler, except that it returns a
	// LocationLink object instead of a Hover object
	async onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined> {
		return (this.fstar_lax ?? this.fstar).onDefinition(defParams);
	}

	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		return (this.fstar_lax ?? this.fstar).onDocumentRangeFormatting(formatParams);
	}

	async killAndRestartSolver() {
		// TODO(klinvill): It looks like this function only restarts the
		// standard F* solver (not the lax one), is this the desired behavior?
		return this.fstar?.killAndRestartSolver();
	}

	sendDiags() { this.diagnosticsRateLimiter.fire(); }
	diagnosticsRateLimiter = new RateLimiter(200, () => {
		if (this.disposed) return;

		const diags =
			[...this.fstar.results.diagnostics, ...this.fstar.results.outOfBandErrors];

		if (this.fstar_lax) {
			// Add diagnostics from the lax position that are after the part processed by the full process.
			const lastPos = mkPosition(this.fstar.results.fragments.findLast(f => !f.invalidatedThroughEdits && f.ok !== undefined)?.range?.end ?? [1, 1]);
			diags.push(...this.fstar_lax.results.diagnostics.filter(d => posLe(lastPos, d.range.start))
				// Downgrade flycheck severity to warning
				.map(diag => ({...diag, source: 'F* flycheck', ...(diag.severity === DiagnosticSeverity.Error && { severity: DiagnosticSeverity.Warning })})));
		}

		this.events.sendDiagnostics({
			uri: this.uri,
			diagnostics: diags,
		});
	});

	sendStatus() { this.statusRateLimiter.fire(); }
	private statusRateLimiter = new RateLimiter(200, () => {
		if (this.disposed) return;

		const fragments = [...this.fstar.results.fragments];

		// TODO: augment with lax process status

		const statusFragments: FragmentStatus[] = [];
		for (const frag of fragments) {
			if (frag.invalidatedThroughEdits && frag.ok !== undefined) continue;
			statusFragments.push({
				range: fstarRangeAsRange(frag.range),
				kind:
					frag.ok === undefined ? 'in-progress' :
					!frag.ok ? 'failed' :
					frag.lax ? 'lax-ok' : 'ok',
			});
		}

		const lastPos = mkPosition(this.fstar.results.fragments.at(-1)?.range?.end ?? [1, 0]);
		if (this.fstar.startedProcessingToPosition) {
			statusFragments.push({
				range: { start: lastPos, end: this.fstar.startedProcessingToPosition },
				kind: 'started',
			});
		}

		this.events.sendStatus({
			uri: this.uri,
			fragments: statusFragments,
		});
	});
}

function isDummyRange(range: FStarRange): boolean {
	return range.fname === 'dummy' || range.beg[1] < 0;
}

interface FragmentResult {
	range: FStarRange;
	ok?: boolean; // undefined means in progress
	lax?: boolean;
	invalidatedThroughEdits: boolean;
}

interface DocumentResults {
	fragments: FragmentResult[];
	diagnostics: Diagnostic[];
	proofStates: IdeProofState[];
	outOfBandErrors: Diagnostic[];
	invalidAfter?: Position;
	sourceText: string;
}
function emptyResults(sourceText: string): DocumentResults {
	return {
		fragments: [],
		diagnostics: [],
		proofStates: [],
		outOfBandErrors: [],
		sourceText,
	};
}

function invalidateResults(results: DocumentResults, newDoc: TextDocument) {
	const diffOff = findFirstDiffPos(results.sourceText, newDoc.getText());
	if (!diffOff) return;
	const diffPos = newDoc.positionAt(diffOff);
	if (results.invalidAfter && posLe(results.invalidAfter, diffPos)) return;
	results.invalidAfter = diffPos;
	for (const frag of results.fragments) {
		if (!posLe(mkPosition(frag.range.end), diffPos)) {
			frag.invalidatedThroughEdits = true;
		}
	}
}

function findFirstDiffPos(a: string, b: string): undefined | number {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return i === a.length && i === b.length ? undefined : i;
}

export class DocumentProcess {
	uri: string;
	filePath: string;

	// Diagnostics, proof states, ranges of checked fragments, etc.
	results: DocumentResults = emptyResults('');
	// Full-buffer queries start out by "replaying" diagnostics from already checked fragments.
	// During this phase we buffer these in newResults to avoid flickering.
	// We switch the buffers when the first fragment is being processed.
	private newResults?: DocumentResults;
	// When a full-buffer query is in progress, startedProcessingToPosition contains the end-position
	startedProcessingToPosition?: Position;

	// We don't want to send too many requests to fstar.exe, so we batch them up
	// and send only the most recent one.
	// currentDoc is always the current editor document (it is updated in place!)
	pendingChange: boolean = false;
	lastDocumentSentToFStar: string;
	
	constructor(public currentDoc: TextDocument,
			public fstarConfig: FStarConfig,
			public documentState: FStarDocumentState,
			public lax: boolean,
			public fstar: FStarConnection) {
		this.uri = currentDoc.uri;
		
		this.filePath = URI.parse(this.uri).fsPath;

		this.lastDocumentSentToFStar = currentDoc.getText();

		fstar.onFullBufferResponse = (res, q) => this.handleSingleFullBufferResponse(res, q);

		// Send the initial dummy vfs-add request to the fstar processes.
		fstar.vfsAddRequest(this.filePath, currentDoc.getText())
			.catch(e => console.error(`vfs-add request to F* process failed: ${e}`));
	}

	dispose() {
		this.fstar.close();
		this.changeDispatcher.cancel();
	}

	private changeDispatcher = new Debouncer(200, () => {
		if (!this.pendingChange) return;
		this.validateFStarDocument(this.lax ? 'lax' : 'cache');
	});
	changeDoc(newDoc: TextDocument) {
		this.currentDoc = newDoc;
		this.pendingChange = true;
		this.changeDispatcher.fire();

		const diffOff = findFirstDiffPos(this.currentDoc.getText(), this.lastDocumentSentToFStar);
		if (diffOff) {
			const diffPos = this.currentDoc.positionAt(diffOff);
			this.fstar.cancelFBQ(posAsFStarPos(diffPos));

			if (this.startedProcessingToPosition && posLe(diffPos, this.startedProcessingToPosition)) {
				this.startedProcessingToPosition = diffPos;
			}
		}

		invalidateResults(this.results, newDoc);
		if (this.newResults) invalidateResults(this.newResults, newDoc);
		this.documentState.sendStatus();
	}

	// Lookup the proof state table for the line at the cursor
	findIdeProofStateAtLine(position: Position) {
		const fstarPos = posAsFStarPos(position);
		return this.results.proofStates.find((ps) => ps.location.beg[0] === fstarPos[0]);
	}

	private applyPendingChange() {
		if (this.pendingChange) {
			this.pendingChange = false;
			this.lastDocumentSentToFStar = this.currentDoc.getText();
		}
	}

	// Send a FullBufferQuery to validate the given document.
	validateFStarDocument(kind: 'full' | 'lax' | 'cache' | 'reload-deps') {
		// Clear pending change events, since we're checking it now
		this.applyPendingChange();

		this.fstar.fullBufferRequest(this.currentDoc.getText(), kind, false);
	}

	validateFStarDocumentToPosition(kind: 'verify-to-position' | 'lax-to-position', position: Position) {
		// Clear pending change events, since we're checking it now
		this.applyPendingChange();

		this.fstar.partialBufferRequest(this.currentDoc.getText(), kind, posAsFStarPos(position));
	}

	private handleSingleFullBufferResponse(response: FullBufferQueryResponse, query: FullBufferQuery) {
		if (response.kind === 'message' && response.level === 'progress') {
			this.handleIdeProgress(response.contents, query);
		} else if (response.kind === 'message' && response.level === 'info') {
			console.info("Info: " + response.contents);
		} else if (response.kind === 'message' && response.level === 'error') {
			// TODO(klinvill): Would be nice to surface these as diagnostics
			// that show where F* crashed.
			console.error("Error: " + response.contents);
		} else if (response.kind === 'message' && response.level === 'warning') {
			// TODO(klinvill): Would be nice to surface these as diagnostics
			// that show the lines that caused F* to emit a warning.
			console.warn("Warning: " + response.contents);
		} else if (response.kind === 'message' && response.level === 'proof-state') {
			this.handleIdeProofState(response.contents);
		} else if (response.kind === 'response') {
			// TODO(klinvill): if a full-buffer query is interrupted, a null response seems to be sent along with a status. Is this always the behavior that occurs?
			if (!response.response) {
				console.info("Query cancelled");
			} else if (Array.isArray(response.response)) {
				void this.handleIdeDiagnostics(response.response);
			} else {
				// ignore
			}
		} else {
			console.warn(`Unhandled full-buffer response: ${JSON.stringify(response)}`);
		}
	}

	async qualifyFilename(fname: string, textdocUri: string): Promise<string> {
		if (fname === '<input>') return textdocUri;

		// if we have a relative path, then qualify it to the base of the
		// F* process's cwd
		const base = this.fstar.fstar_config().cwd;
		if (!path.isAbsolute(fname) && base) {
			fname = path.join(base, fname);
		}

		try {
			// Resolve symlinks in the path.
			// VS Code does not resolve symlinks itself,
			// and go-to-definition etc. would go to files like stage2/out/lib/fstar/ulib/Prims.fst
			fname = await util.promisify(fs.realpath)(fname);
		} catch {
			// fs.realpath fails if the file no longer exists
			// https://github.com/FStarLang/fstar-vscode-assistant/issues/53
		}

		return pathToFileURL(fname).toString();
	}

	private handleIdeProofState(response: IdeProofState) {
		if (this.newResults) {
			console.error('received proof state before full-buffer-fragmented-started');
		}
		this.results.proofStates.push(response);
	}

	private handleIdeProgress(contents: IdeProgress, query: FullBufferQuery) {
		if (contents.stage === 'full-buffer-started') {
			if (query.args['to-position']) {
				const {line, column} = query.args['to-position'];
				this.startedProcessingToPosition = mkPosition([line, column]);
			} else {
				// FIXME: this can be out of date
				this.startedProcessingToPosition = this.currentDoc.positionAt(this.currentDoc.getText().length);
			}

			this.newResults = emptyResults(query.args.code);
			return;
		}

		if (contents.stage === 'full-buffer-finished') {
			if (this.newResults) {
				// No fragments were processed.
				this.newResults.outOfBandErrors = this.results.outOfBandErrors;
				this.newResults.proofStates = this.results.proofStates;
				this.results = this.newResults;
				this.newResults = undefined;
			} else {
				// When cancelling an FBQ, F* sends a full-buffer-fragment-started for the last fragment but no full-buffer-fragment-ok
				const lastFrag = this.results.fragments.at(-1);
				if (lastFrag && lastFrag.ok === undefined) {
					this.results.fragments.pop();
				}
			}
			this.startedProcessingToPosition = undefined;

			this.documentState.sendStatus();
			this.documentState.sendDiags();
			return;
		}

		if (contents.stage === 'full-buffer-fragment-started') {
			if (this.newResults) {
				// This is the first fragment the server actually processes,
				// the previous ones were cached and did not generate proof state infos.

				// So let's preserve those infos from previously.
				const rng = fstarRangeAsRange(contents.ranges);
				this.newResults.outOfBandErrors.push(...this.results.outOfBandErrors.filter(d => posLe(d.range.end, rng.start)));
				this.newResults.proofStates.push(...this.results.proofStates.filter(s => fstarPosLe(s.location.end, contents.ranges.beg)));

				this.results = this.newResults;
				this.newResults = undefined;
			}

			const invalidatedThroughEdits = !!this.results.invalidAfter
				&& !posLe(mkPosition(contents.ranges.end), this.results.invalidAfter);

			this.results.fragments.push({
				range: contents.ranges,
				invalidatedThroughEdits,
			});

			this.documentState.sendStatus();

			return;
		}
		if (contents.stage === 'full-buffer-fragment-ok' || contents.stage === 'full-buffer-fragment-lax-ok') {
			const ok = true;
			const lax = contents.stage !== 'full-buffer-fragment-ok';

			if (this.newResults) {
				// This is a cached result.
				const invalidatedThroughEdits = !!this.newResults.invalidAfter
					&& !posLe(mkPosition(contents.ranges.end), this.newResults.invalidAfter);
				this.newResults.fragments.push({ ok, lax, range: contents.ranges, invalidatedThroughEdits });
				return;
			}

			const frag = this.results.fragments.at(-1)!;
			frag.ok = ok;
			frag.lax = lax;
			frag.invalidatedThroughEdits = !!this.results.invalidAfter
				&& !posLe(mkPosition(contents.ranges.end), this.results.invalidAfter);

			this.documentState.sendStatus();

			return;
		}
		if (contents.stage === 'full-buffer-fragment-failed') {
			if (this.newResults) {
				console.error('full-buffer-fragment-failed without fill-buffer-fragment-started');
				return;
			}

			const frag = this.results.fragments.at(-1)!;
			frag.ok = false;

			this.documentState.sendStatus();

			return;
		}
	}

	async ideDiagAsDiag(diag: IdeDiagnostic): Promise<Diagnostic> {
		function ideErrorLevelAsDiagnosticSeverity(level: string): DiagnosticSeverity {
			switch (level) {
				case "warning": return DiagnosticSeverity.Warning;
				case "error": return DiagnosticSeverity.Error;
				case "info": return DiagnosticSeverity.Information;
				default: return DiagnosticSeverity.Error;
			}
		}

		const defPos: Position = {line: 0, character: 0};
		const defRange: Range = {start: defPos, end: defPos};

		const ranges = [...diag.ranges]
			.filter(rng => !isDummyRange(rng));
		let mainRange = defRange;

		// Use the first range as the range of the diagnostic if it is in the current file,
		// provide the rest as related info.
		// Note: this seems to be wrong for pulse. https://github.com/FStarLang/pulse/issues/36
		if (ranges.length > 0 && ranges[0].fname === '<input>') {
			mainRange = fstarRangeAsRange(ranges.shift()!);
		}

		return {
			message: diag.message,
			severity: ideErrorLevelAsDiagnosticSeverity(diag.level),
			source: 'F*',
			range: mainRange,
			relatedInformation: await Promise.all(ranges.map(async rng => ({
				location: {
					uri: await this.qualifyFilename(rng.fname, this.uri),
					range: fstarRangeAsRange(rng),
				},
				message: 'related location',
			}))),
		};
	}

	private async handleIdeDiagnostics(response: IdeDiagnostic[]) {
		(this.newResults ?? this.results).diagnostics.push(...await Promise.all(response.map(diag => this.ideDiagAsDiag(diag))));
		this.documentState.sendDiags();
	}

	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		const word = findWordAtPosition(this.currentDoc, textDocumentPosition.position);
		if (word.word.length < 2) return;
		const response = await this.fstar.autocompleteRequest(word.word);
		if (response.status !== 'success') return;
		const items: CompletionItem[] = [];
		response.response.forEach(([matchLength, annotation, candidate]) => {
			// vscode replaces the word at the cursor with the completion item
			// but its notion of word is the suffix of the identifier after the last dot
			// so the completion we provide is the suffix of the identifier after the last dot
			const label = candidate.lastIndexOf('.') > 0 ? candidate.substring(candidate.lastIndexOf('.') + 1) : candidate;
			const item: CompletionItem = {
				label: label,
				kind: CompletionItemKind.Method,
			};
			items.push(item);
		});
		return items;
	}

	async onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> {
		const word = findWordAtPosition(this.currentDoc, textDocumentPosition.position);
		// The filename '<input>' here must be exactly the same the we used in the full buffer request.
		const result = await this.fstar.lookupQuery('<input>', textDocumentPosition.position, word.word);
		if (result.status !== 'success') return;
		switch (result.response.kind) {
			case 'symbol': return {
				contents: {
					kind: 'markdown',
					value:
						"```fstar\n" +
						result.response.name + ":\n" +
						result.response.type + "\n" +
						"```\n"
				},
			};
			case 'module': return {
				contents: {
					kind: 'markdown',
					value: "```fstar\nmodule "+result.response.name+"\n```\n"
				},
			};
		}
	}

	// The onDefinition handler is called when the user clicks on a symbol
	// It's very similar to the onHover handler, except that it returns a
	// LocationLink object instead of a Hover object
	async onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined> {
		const word = findWordAtPosition(this.currentDoc, defParams.position);
		// The filename '<input>' here must be exactly the same the we used in the full buffer request.
		const result = await this.fstar.lookupQuery('<input>', defParams.position, word.word);
		if (result.status !== 'success') return [];
		if (result.response.kind === 'symbol') {
			const defined_at = result.response["defined-at"];
			if (isDummyRange(defined_at)) {
				// Spliced definitions currently have dummy ranges
				// https://github.com/FStarLang/fstar-vscode-assistant/issues/37
				return;
			}
			const range = fstarRangeAsRange(defined_at);
			return [{
				targetUri: await this.qualifyFilename(defined_at.fname, this.currentDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		} else if (result.response.kind === 'module') {
			const range: Range = {start: {line: 0, character: 0}, end: {line: 0, character: 0}};
			return [{
				targetUri: await this.qualifyFilename(result.response.path, this.currentDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		}
	}

	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		const text = this.currentDoc.getText(formatParams.range);
		const debug = false;
		const fstarFormatter = FStar.trySpawnFstar(this.fstarConfig, 'Prims.fst', debug);
		if (!fstarFormatter) return [];
		let formattedCode: string | undefined;
		fstarFormatter.handleResponse = reply => {
			if (reply.response && reply.status == "success" || reply.response["formatted-code"]) {
				formattedCode = reply.response['formatted-code'];
			}
		};
		fstarFormatter.jsonlIface.sendMessage({ 'query-id': '1', query: 'format', args: { code: text } });
		fstarFormatter.proc.stdin?.end();
		const exitCode = await new Promise(resolve => fstarFormatter.proc.on('close', resolve));
		return formattedCode ? [TextEdit.replace(formatParams.range, formattedCode)] : [];
	}

	async killAndRestartSolver() {
		await this.fstar.restartSolver();
	}
}