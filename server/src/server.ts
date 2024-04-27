import {
	TextDocuments,
	Diagnostic,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Position,
	Range,
	Hover,
	DefinitionParams,
	WorkspaceFolder,
	LocationLink,
	DocumentRangeFormattingParams,
	TextEdit,
	Connection,
	DiagnosticSeverity,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';

import { defaultSettings, fstarVSCodeAssistantSettings } from './settings';
import { formatIdeProofState, fstarPosLe, fstarRangeAsRange, mkPosition, posAsFStarPos, posLe, rangeAsFStarRange } from './utils';
import { FStarConnection } from './fstar_connection';
import { FStar, FStarConfig } from './fstar';
import { FStarRange, IdeProofState, IdeProgress, IdeDiagnostic, FullBufferQueryResponse, FStarPosition, FullBufferQuery } from './fstar_messages';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { statusNotification, FragmentStatus, killAndRestartSolverNotification, restartNotification, verifyToPositionNotification, killAllNotification } from './fstarLspExtensions';
import { Debouncer, RateLimiter } from './signals';

// LSP Server
//
// The LSP Server interfaces with both the Client (e.g. the vscode extension)
// and the F* processes that are used to check files. It is started run using
// the `server.run()` method. The `Connection` and text document manager
// are passed in as arguments, following the dependency injection pattern. This
// allows for easier mocking out of these connections which in turn allows for
// easier testing.
export class Server {
	documentStates: Map<string, DocumentState> = new Map();
	// Text document manager.
	documents: TextDocuments<TextDocument>;
	// All the open workspace folders
	workspaceFolders: WorkspaceFolder[] = [];
	configurationSettings: fstarVSCodeAssistantSettings = defaultSettings;
	// Connection to the client (the extension in the IDE)
	connection: Connection;

	// Client (e.g. extension) capabilities
	hasConfigurationCapability: boolean = false;
	hasWorkspaceFolderCapability: boolean = false;
	hasDiagnosticRelatedInformationCapability: boolean = false;

	constructor(connection: Connection, documents: TextDocuments<TextDocument>) {
		this.documents = documents;
		this.connection = connection;

		// The main entry point when a document is opened
		//  * find the .fst.config.json file for the document in the workspace, otherwise use a default config
		//  * spawn 2 fstar processes: one for typechecking, one lax process for fly-checking and symbol lookup
		//  * set event handlers to read the output of the fstar processes
		//  * send the current document to both processes to start typechecking
		this.documents.onDidOpen(ev =>
			this.onOpenHandler(ev.document)
				.catch(err => this.connection.window.showErrorMessage(
					`${URI.parse(ev.document.uri).fsPath}: ${err.toString()}`))
				.catch());

		// Only keep settings for open documents
		this.documents.onDidClose(e => {
			this.documentStates.get(e.document.uri)?.dispose();
			this.documentStates.delete(e.document.uri);
		});

		// The content of a text document has changed. This event is emitted
		// when the text document first opened or when its content has changed.
		this.documents.onDidChangeContent(change =>
			this.getDocumentState(change.document.uri)?.changeDoc(change.document));

		this.documents.onDidSave(change => {
			if (this.configurationSettings.verifyOnSave) {
				this.getDocumentState(change.document.uri)?.verifyAll();
			}
		});


		// Register connection handlers.
		//
		// Note: when passed as functions, `this` is not bound for class methods
		// (and will therefore be undefined). We instead need to either use the
		// method within a closure, or explicitly bind it here. See
		// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/thiscallbacks
		// for the official documentation on this behavior, and
		// https://javascript.info/bind for another explanation.
		this.connection.onInitialize(params => this.onInitialize(params));
		this.connection.onInitialized(() => this.onInitializedHandler());
		// We don't do anything special when the configuration changes
		this.connection.onDidChangeConfiguration(() => this.updateConfigurationSettings());
		this.connection.onCompletion(textDocumentPosition =>
			this.getDocumentState(textDocumentPosition.textDocument.uri)?.onCompletion(textDocumentPosition));
		// This handler resolves additional information for the item selected in
		// the completion list.
		this.connection.onCompletionResolve(item => item);
		this.connection.onHover(textDocumentPosition =>
			this.getDocumentState(textDocumentPosition.textDocument.uri)?.onHover(textDocumentPosition));
		this.connection.onDefinition(defParams =>
			this.getDocumentState(defParams.textDocument.uri)?.onDefinition(defParams));
		this.connection.onDocumentRangeFormatting(formatParams =>
			this.getDocumentState(formatParams.textDocument.uri)?.onDocumentRangeFormatting(formatParams));

		// Custom events
		this.connection.onNotification(verifyToPositionNotification, ({uri, position, lax}) => {
			const state = this.getDocumentState(uri);
			if (lax) {
				state?.laxToPosition(position);
			} else {
				state?.verifyToPosition(position);
			}
		});
		this.connection.onNotification(restartNotification, ({uri}) =>
			this.onRestartRequest(uri));
		this.connection.onNotification(killAndRestartSolverNotification, ({uri}) =>
			this.getDocumentState(uri)?.killAndRestartSolver());
		this.connection.onNotification(killAllNotification, () =>
			this.onKillAllRequest());
	}

	run() {
		// Make the text document manager listen on the connection
		// for open, change and close text document events
		this.documents.listen(this.connection);

		// Listen on the connection
		this.connection.listen();
	}

	getDocumentState(uri: string): DocumentState | undefined {
		return this.documentStates.get(uri);
	}

	async updateConfigurationSettings() {
		const settings = await this.connection.workspace.getConfiguration('fstarVSCodeAssistant');
		if (settings.debug) {
			console.log("Server got settings: " + JSON.stringify(settings));
		}
		this.configurationSettings = settings;

		// FStarConnection objects store their own debug flag, so we need to update them all with the latest value.
		this.documentStates.forEach((docState, uri) => {
			docState.fstar.fstar.debug = settings.debug;
			if (docState.fstar_lax) docState.fstar_lax.fstar.debug = settings.debug;
		});
	}

	async refreshDocumentState(uri: string) {
		const filePath = URI.parse(uri).fsPath;
		const fstar_config = await FStar.getFStarConfig(filePath, this.workspaceFolders, this.connection, this.configurationSettings);

		const doc = this.documents.get(uri);
		if (!doc || this.documentStates.has(uri)) return;

		const fstar = FStarConnection.tryCreateFStarConnection(fstar_config, filePath, this.configurationSettings.debug);
		if (!fstar) return;
		const fstar_lax = this.configurationSettings.flyCheck ? FStarConnection.tryCreateFStarConnection(fstar_config, filePath, this.configurationSettings.debug, 'lax') : undefined;

		const docState = new DocumentState(doc, fstar_config, this, fstar, fstar_lax);
		this.documentStates.set(uri, docState);
	}

	// Initialization of the LSP server: Called once when the workspace is opened
	// Advertize the capabilities of the server
	//   - incremental text documentation sync
	//   - completion
	//   - hover
	//   - definitions
	//   - workspaces
	//   - reformatting
	onInitialize(params: InitializeParams): InitializeResult {
		const capabilities = params.capabilities;
		if (params.workspaceFolders) {
			this.workspaceFolders = params.workspaceFolders;
		}
		// Does the client support the `workspace/configuration` request?
		// If not, we fall back using global settings.
		// This is left-over from the lsp-sample
		// We don't do anything special with configuations yet
		this.hasConfigurationCapability = !!(
			capabilities.workspace && !!capabilities.workspace.configuration
		);
		this.hasWorkspaceFolderCapability = !!(
			capabilities.workspace && !!capabilities.workspace.workspaceFolders
		);
		this.hasDiagnosticRelatedInformationCapability = !!(
			capabilities.textDocument &&
			capabilities.textDocument.publishDiagnostics &&
			capabilities.textDocument.publishDiagnostics.relatedInformation
		);
		const result: InitializeResult = {
			capabilities: {
				textDocumentSync: TextDocumentSyncKind.Incremental,
				completionProvider: {
					resolveProvider: true
				},
				hoverProvider: true,
				definitionProvider: true,
				documentRangeFormattingProvider: true,
			}
		};
		// Workspace folders: We use them for .fst.config.json files
		if (this.hasWorkspaceFolderCapability) {
			result.capabilities.workspace = {
				workspaceFolders: {
					supported: true
				}
			};
		}
		return result;
	}

	// The client (e.g. extension) acknowledged the initialization
	private async onInitializedHandler() {
		await this.updateConfigurationSettings();
		if (this.hasConfigurationCapability) {
			// Register for all configuration changes.
			await this.connection.client.register(DidChangeConfigurationNotification.type, undefined);
			// const settings = connection.workspace.getConfiguration('fstarVSCodeAssistant');
			// const settings = connection.workspace.getConfiguration();
			// console.log("Server got settings: " + JSON.stringify(settings));
		}
		if (this.hasWorkspaceFolderCapability) {
			this.connection.workspace.onDidChangeWorkspaceFolders(_event => {
				// We don't do anything special when workspace folders change
				// We should probably reset the workspace configs and re-read the .fst.config.json files
				if (this.configurationSettings.debug) {
					this.connection.console.log('Workspace folder change event received.');
				}
			});
		}
	}

	async onOpenHandler(textDocument: TextDocument) {
		await this.updateConfigurationSettings();
		await this.refreshDocumentState(textDocument.uri);

		const docState = this.getDocumentState(textDocument.uri);
		if (docState === undefined) { return; }

		// And ask the main fstar process to verify it
		if (this.configurationSettings.verifyOnOpen) {
			docState.fstar.validateFStarDocument('full');
		}

		// And ask the lax fstar process to verify it
		docState.fstar_lax?.validateFStarDocument('lax');
	}

	private async onRestartRequest(uri: string) {
		if (!this.documents.get(uri)) return;
		this.documentStates.get(uri)?.dispose();
		this.documentStates.delete(uri);
		await this.refreshDocumentState(uri);
		// And ask the lax fstar process to verify it
		this.getDocumentState(uri)?.fstar_lax?.validateFStarDocument('lax');
	}

	private onKillAllRequest() {
		const oldDocStates = [...this.documentStates.values()];
		this.documentStates = new Map();
		for (const v of oldDocStates) {
			v.dispose();
		}
	}
}
	
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

export class DocumentState {
	uri: string;

	// The main fstar.exe process for verifying the current document
	fstar: DocumentProcess;

	// The fstar.exe process for quickly handling on-change events, symbol lookup etc
	// If flycheck is disabled, then we don't spawn the second process and this field is undefined.
	fstar_lax?: DocumentProcess;

	private disposed = false;

	constructor(currentDoc: TextDocument,
			public fstarConfig: FStarConfig,
			public server: Server,
			fstar: FStarConnection,
			fstar_lax?: FStarConnection) {
		this.uri = currentDoc.uri;
		this.fstar = new DocumentProcess(currentDoc, fstarConfig, this, false, fstar);
		this.fstar_lax = fstar_lax && new DocumentProcess(currentDoc, fstarConfig, this, true, fstar_lax);
	}

	dispose() {
		this.disposed = true;
		this.fstar.dispose();
		this.fstar_lax?.dispose();

		// Clear all diagnostics for a document when it is closed
		void this.server.connection.sendDiagnostics({
			uri: this.uri,
			diagnostics: [],
		});
		void this.server.connection.sendNotification(statusNotification, {
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

	verifyAll() {
		this.fstar.validateFStarDocument('full');
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

	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		return (this.fstar_lax ?? this.fstar).onCompletion(textDocumentPosition);
	}

	async onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> {
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
	diagnosticsRateLimiter = new RateLimiter(100, () => {
		if (this.disposed) return;

		const diags =
			[...this.fstar.results.diagnostics, ...this.fstar.results.outOfBandErrors];

		if (this.fstar_lax) {
			// Add diagnostics from the lax position that are after the part processed by the full process.
			const lastPos = mkPosition(this.fstar.results.fragments.findLast(f => !f.invalidatedThroughEdits && f.ok !== undefined)?.range?.end || [1, 1]);
			diags.push(...this.fstar_lax.results.diagnostics.filter(d => posLe(lastPos, d.range.start)));
		}

		void this.server.connection.sendDiagnostics({
			uri: this.uri,
			diagnostics: diags,
		});
	});

	sendStatus() { this.statusRateLimiter.fire(); }
	private statusRateLimiter = new RateLimiter(100, () => {
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

		void this.server.connection.sendNotification(statusNotification, {
			uri: this.uri,
			fragments: statusFragments,
		});
	});
}

function isDummyRange(range: FStarRange): boolean {
	return range.fname === 'dummy';
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
			public documentState: DocumentState,
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
			this.handleIdeProgress(response.contents as IdeProgress, query);
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
				this.handleIdeDiagnostics(response.response);
			} else {
				// ignore
			}
		} else {
			console.warn(`Unhandled full-buffer response: ${JSON.stringify(response)}`);
		}
	}

	qualifyFilename(fname: string, textdocUri: string): string {
		if (fname != "<input>") {
			// if we have a relative path, then qualify it to the base of the
			// F* process's cwd
			const base = this.fstar.fstar_config().cwd;
			if (!path.isAbsolute(fname) && base) {
				//concate the base and the relative path
				return pathToFileURL(path.join(base, fname)).toString();
			}
			else {
				return pathToFileURL(fname).toString();
			}
		}
		return textdocUri;
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

	ideDiagAsDiag(diag: IdeDiagnostic): Diagnostic {
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

		const ranges = [...diag.ranges];
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
			range: mainRange,
			relatedInformation: ranges.map(rng => ({
				location: {
					uri: this.qualifyFilename(rng.fname, this.uri),
					range: fstarRangeAsRange(rng),
				},
				message: 'related location',
			})),
		};
	}

	private handleIdeDiagnostics(response: IdeDiagnostic[]) {
		(this.newResults ?? this.results).diagnostics.push(...response.map(diag => this.ideDiagAsDiag(diag)));
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
		// First, check if we have proof state information for this line
		const proofState = this.findIdeProofStateAtLine(textDocumentPosition.position);
		if (proofState) {
			return {
				contents: {
					kind: 'markdown',
					value: formatIdeProofState(proofState)
				}
			};
		}
		// Otherwise, check the symbol information for this symbol
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
				targetUri: this.qualifyFilename(defined_at.fname, this.currentDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		} else if (result.response.kind === 'module') {
			const range: Range = {start: {line: 0, character: 0}, end: {line: 0, character: 0}};
			return [{
				targetUri: this.qualifyFilename(result.response.path, this.currentDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		}
	}

	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		const text = this.currentDoc.getText(formatParams.range);
		// call fstar.exe synchronously to format the text
		const format_query = {
			"query-id": "1",
			query: "format",
			args: {
				code: text
			}
		};
		// TODO(klinvill): This interaction with the F* executable should be moved to the FStar class or file.
		const fstarFormatter =
			cp.spawnSync(this.fstarConfig.fstar_exe ?? "fstar.exe",
				["--ide", "prims.fst"],
				{ input: JSON.stringify(format_query) });
		const data = fstarFormatter.stdout.toString();
		const replies = data.trim().split('\n').map(line => { return JSON.parse(line); });
		if (replies.length != 2 ||
			replies[0].kind != "protocol-info" ||
			replies[1].kind != "response" ||
			!replies[1].response ||
			replies[1].status != "success" ||
			!replies[1].response["formatted-code"]) {
			return [];
		}
		const formattedCode = replies[1].response["formatted-code"];
		return [TextEdit.replace(formatParams.range, formattedCode)];
	}

	async killAndRestartSolver() {
		await this.fstar.restartSolver();
	}
}
