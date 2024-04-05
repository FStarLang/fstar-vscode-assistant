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
	_Connection,
	DiagnosticSeverity,
	DiagnosticRelatedInformation
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';
import * as crypto from 'crypto';

import { defaultSettings, fstarVSCodeAssistantSettings } from './settings';
import { formatIdeProofState, fstarRangeAsRange, mkPosition, rangeAsFStarRange } from './utils';
import { ClientConnection, StatusOkMessage, ok_kind } from './client_connection';
import { FStarConnection } from './fstar_connection';
import { FStar, FStarConfig } from './fstar';
import { FStarRange, IdeProofState, IdeProgress, IdeDiagnostic, FullBufferQueryResponse, FStarPosition } from './fstar_messages';
import * as path from 'path';
import { pathToFileURL } from 'url';

// LSP Server
//
// The LSP Server interfaces with both the Client (e.g. the vscode extension)
// and the F* processes that are used to check files. It is started run using
// the `server.run()` method. The `ClientConnection` and text document manager
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
	connection: ClientConnection;

	// Client (e.g. extension) capabilities
	hasConfigurationCapability: boolean = false;
	hasWorkspaceFolderCapability: boolean = false;
	hasDiagnosticRelatedInformationCapability: boolean = false;

	constructor(connection: ClientConnection, documents: TextDocuments<TextDocument>) {
		this.documents = documents;
		this.connection = connection;

		// The main entry point when a document is opened
		//  * find the .fst.config.json file for the document in the workspace, otherwise use a default config
		//  * spawn 2 fstar processes: one for typechecking, one lax process for fly-checking and symbol lookup
		//  * set event handlers to read the output of the fstar processes
		//  * send the current document to both processes to start typechecking
		this.documents.onDidOpen(ev =>
			this.onOpenHandler(ev.document).catch(err =>
				this.connection.sendAlert({
					uri: ev.document.uri,
					message: err.toString(),
				})));

		// Only keep settings for open documents
		this.documents.onDidClose(e => {
			this.documentStates.get(e.document.uri)?.dispose();
			this.documentStates.delete(e.document.uri);
			// Clear all diagnostics for a document when it is closed
			this.connection.sendDiagnostics({
				uri: e.document.uri,
				lax: true,
				diagnostics: []
			});
			this.connection.sendDiagnostics({
				uri: e.document.uri,
				lax: false,
				diagnostics: []
			});
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
		this.connection.conn.onInitialize(params => this.onInitialize(params));
		this.connection.conn.onInitialized(() => this.onInitializedHandler());
		// We don't do anything special when the configuration changes
		this.connection.conn.onDidChangeConfiguration(async _change => {
			await this.updateConfigurationSettings();
		});
		this.connection.conn.onDidChangeWatchedFiles(_change => {
			// Monitored files have change in VSCode
			// connection.console.log('We received an file change event');
		});
		this.connection.conn.onCompletion(textDocumentPosition =>
			this.getDocumentState(textDocumentPosition.textDocument.uri)?.onCompletion(textDocumentPosition));
		// This handler resolves additional information for the item selected in
		// the completion list.
		this.connection.conn.onCompletionResolve(item => item);
		this.connection.conn.onHover(textDocumentPosition =>
			this.getDocumentState(textDocumentPosition.textDocument.uri)?.onHover(textDocumentPosition));
		this.connection.conn.onDefinition(defParams =>
			this.getDocumentState(defParams.textDocument.uri)?.onDefinition(defParams));
		this.connection.conn.onDocumentRangeFormatting(formatParams =>
			this.getDocumentState(formatParams.textDocument.uri)?.onDocumentRangeFormatting(formatParams));

		// Custom events
		this.connection.conn.onRequest("fstar-vscode-assistant/verify-to-position", params =>
			this.getDocumentState(params[0])?.onVerifyToPositionRequest(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/lax-to-position", params =>
			this.getDocumentState(params[0])?.onLaxToPositionRequest(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/restart", uri =>
			this.onRestartRequest(uri));
		this.connection.conn.onRequest("fstar-vscode-assistant/text-doc-changed", params =>
			this.getDocumentState(params[0])?.onTextDocChanged(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-and-restart-solver", uri =>
			this.getDocumentState(uri)?.killAndRestartSolver());
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-all", params =>
			this.onKillAllRequest());
	}

	run() {
		// Make the text document manager listen on the connection
		// for open, change and close text document events
		this.documents.listen(this.connection.conn);

		// Listen on the connection
		this.connection.conn.listen();
	}

	getDocumentState(uri: string): DocumentState | undefined {
		return this.documentStates.get(uri);
	}

	getDocument(uri: string): TextDocument | undefined {
		return this.documents.get(uri);
	}

	async updateConfigurationSettings() {
		const settings = await this.connection.conn.workspace.getConfiguration('fstarVSCodeAssistant');
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
			await this.connection.conn.client.register(DidChangeConfigurationNotification.type, undefined);
			// const settings = connection.workspace.getConfiguration('fstarVSCodeAssistant');
			// const settings = connection.workspace.getConfiguration();
			// console.log("Server got settings: " + JSON.stringify(settings));
		}
		if (this.hasWorkspaceFolderCapability) {
			this.connection.conn.workspace.onDidChangeWorkspaceFolders(_event => {
				// We don't do anything special when workspace folders change
				// We should probably reset the workspace configs and re-read the .fst.config.json files
				if (this.configurationSettings.debug) {
					this.connection.conn.console.log('Workspace folder change event received.');
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

	private async onRestartRequest(uri: any) {
		// console.log("Received restart request with parameters: " + uri);
		const textDocument = this.getDocument(uri);
		if (!textDocument) return;
		this.documentStates.get(uri)?.dispose();
		this.documentStates.delete(uri);
		this.connection.sendStatusClear({ uri: textDocument.uri });
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

	constructor(currentDoc: TextDocument,
			public fstarConfig: FStarConfig,
			public server: Server,
			fstar: FStarConnection,
			fstar_lax?: FStarConnection) {
		this.uri = currentDoc.uri;
		this.fstar = new DocumentProcess(currentDoc, fstarConfig, server, false, fstar);
		this.fstar_lax = fstar_lax && new DocumentProcess(currentDoc, fstarConfig, server, true, fstar_lax);
	}

	dispose() {
		this.fstar.dispose();
		this.fstar_lax?.dispose();
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
		this.fstar.validateFStarDocumentToPosition('verify-to-position', { line: position.line + 1, column: position.character });
		this.fstar_lax?.validateFStarDocument('lax');
	}

	laxToPosition(position: Position) {
		this.fstar.validateFStarDocumentToPosition('lax-to-position', { line: position.line + 1, column: position.character });
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

	onVerifyToPositionRequest(params: any) {
		const position: { line: number, character: number } = params[1];
		this.verifyToPosition(position);
	}

	onLaxToPositionRequest(params: any) {
		const position: { line: number, character: number } = params[1];
		this.laxToPosition(position);
	}

	onTextDocChanged(params: any) {
		const range: { line: number; character: number }[] = params[1];
		// TODO(klinvill): It looks like this function can only be called for
		// non-lax checking. Is that correct?
		const fstarPos: FStarPosition = [range[0].line + 1, range[0].character];
		this.fstar?.fstar?.cancelFBQ(fstarPos);
		this.fstar_lax?.fstar?.cancelFBQ(fstarPos);
	}

	async killAndRestartSolver() {
		// TODO(klinvill): It looks like this function only restarts the
		// standard F* solver (not the lax one), is this the desired behavior?
		return this.fstar?.killAndRestartSolver();
	}
}

export class DocumentProcess {
	uri: string;
	filePath: string;

	fstar_diagnostics: Diagnostic[] = [];

	// A proof-state table populated by fstar_ide when running tactics, displayed in onHover
	hover_proofstate_info: Map<number, IdeProofState> = new Map();
	// A flag to indicate if the prefix of the buffer is stale
	prefix_stale: boolean = false;
	
	// We don't want to send too many requests to fstar.exe, so we batch them up
	// and send only the most recent one.
	lastPendingChange?: TextDocument;
	changeDispatcher?: NodeJS.Timeout;
	
	constructor(public currentDoc: TextDocument,
			public fstarConfig: FStarConfig,
			public server: Server,
			public lax: boolean,
			public fstar: FStarConnection) {
		this.uri = currentDoc.uri;
		
		this.filePath = URI.parse(this.uri).fsPath;

		fstar.onFullBufferResponse = res => this.handleSingleFullBufferResponse(res);

		// Send the initial dummy vfs-add request to the fstar processes.
		fstar.vfsAddRequest(this.filePath, currentDoc.getText())
			.catch(e => console.error(`vfs-add request to F* process failed: ${e}`));
	}

	dispose() {
		this.fstar.close();
		clearTimeout(this.changeDispatcher);
	}

	get connection() { return this.server.connection; }

	changeDoc(newDoc: TextDocument) {
		clearTimeout(this.changeDispatcher);
		this.lastPendingChange = newDoc;
		this.changeDispatcher = setTimeout(() => {
			if (!this.lastPendingChange) return;
			this.validateFStarDocument(this.lax ? 'lax' : 'cache');
		}, 200);
	}

	// Lookup the proof state table for the line at the cursor
	findIdeProofStateAtLine(position: Position) {
		const rangeKey = position.line + 1;
		return this.hover_proofstate_info.get(rangeKey);
	}

	clearIdeProofProofStateAtRange(range: FStarRange) {
		const line_ctr = range.beg[0];
		const end_line_ctr = range.end[0];
		for (let i = line_ctr; i <= end_line_ctr; i++) {
			this.hover_proofstate_info.delete(i);
		}
	}

	private applyPendingChange() {
		if (this.lastPendingChange) {
			this.currentDoc = this.lastPendingChange;
			this.lastPendingChange = undefined;
		}
	}

	// Send a FullBufferQuery to validate the given document.
	validateFStarDocument(kind: 'full' | 'lax' | 'cache' | 'reload-deps') {
		// Clear pending change events, since we're checking it now
		this.applyPendingChange();

		this.connection.sendClearDiagnostics({ uri: this.uri });

		if (!this.lax) {
			// If this is non-lax requests, send a status clear messages to VSCode
			// to clear the gutter icons and error squiggles
			// They will be reported again if the document is not verified
			this.prefix_stale = false;
			this.connection.sendStatusClear({ uri: this.uri });
			const ranges = [Range.create(mkPosition([0, 0]), mkPosition([this.currentDoc.lineCount, 0]))];
			if (kind == "full") { this.connection.sendStatusStarted({ uri: this.uri, ranges: ranges }); }
		}

		this.fstar.fullBufferRequest(this.currentDoc.getText(), kind, false);
	}

	validateFStarDocumentToPosition(kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }) {
		// Clear pending change events, since we're checking it now
		this.applyPendingChange();

		// console.log("ValidateFStarDocumentToPosition( " + textDocument.uri + ", " + kind);
		this.connection.sendClearDiagnostics({ uri: this.uri });
		// If this is non-lax requests, send a status clear messages to VSCode
		// to clear the gutter icons and error squiggles
		// They will be reported again if the document is not verified
		this.prefix_stale = false;
		this.connection.sendStatusClear({ uri: this.uri });
		const ranges = [Range.create(mkPosition([0, 0]), mkPosition([position.line, 0]))];
		this.connection.sendStatusStarted({ uri: this.uri, ranges: ranges });

		this.fstar.partialBufferRequest(this.currentDoc.getText(), kind, position);
	}

	private handleSingleFullBufferResponse(response: FullBufferQueryResponse) {
		if (response.kind === 'message' && response.level === 'progress') {
			this.handleIdeProgress(response.contents as IdeProgress);
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
			this.handleIdeProofState(response.contents as IdeProofState);
		} else if (response.kind === 'response') {
			// TODO(klinvill): if a full-buffer query is interrupted, a null response seems to be sent along with a status. Is this always the behavior that occurs?
			if (!response.response) {
				console.info("Query cancelled");
			} else if (Array.isArray(response.response)) {
				this.handleIdeDiagnostics(response.response as IdeDiagnostic[]);
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

	// If we get a proof state dump message, we store it in the proof state map
	private handleIdeProofState(response: IdeProofState) {
		// console.log("Got ide proof state " + JSON.stringify(response));
		const range_key = response.location.beg[0];
		const hoverProofStateMap = this.hover_proofstate_info;
		if (hoverProofStateMap) {
			// console.log("Setting proof state hover info at line: " +range_key);
			hoverProofStateMap.set(range_key, response);
		}
	}

	// If a declaration in a full-buffer is verified, fstar_ide sends
	// us first a  full-buffer-fragment-started message
	// We send a status-ok to the client which will
	// and show an hourglass icon in the gutter for those locations
	//
	// Then we may get a full-buffer-fragment-ok message.
	//
	// We use that to send a status-ok which will clear the hourglass icon
	// and show a checkmark in the gutter for the locations we send
	private handleIdeProgress(contents: IdeProgress) {
		if (contents.stage == "full-buffer-started") {
			this.fstar_diagnostics = [];
			return;
		}
		if (contents.stage == "full-buffer-finished") {
			this.connection.sendDiagnostics({
				uri: this.uri,
				lax: this.lax,
				diagnostics: this.fstar_diagnostics
			});
			return;
		}
		if (this.lax) { return; }
		// We don't send intermediate diagnostics and gutter icons for flycheck progress
		if (contents.stage == "full-buffer-fragment-ok" ||
			contents.stage == "full-buffer-fragment-lax-ok") {
			if (this.prefix_stale) { return; }
			const rng = contents.ranges;
			if (!contents["code-fragment"]) { return; }
			const code_fragment = contents["code-fragment"];
			const currentText = this.currentDoc.getText(fstarRangeAsRange(code_fragment.range));
			// compute an MD5 digest of currentText.trim
			const md5 = crypto.createHash('md5');
			md5.update(currentText.trim());
			const digest = md5.digest('hex');
			if (digest != code_fragment['code-digest']) {
				if (this.server.configurationSettings.debug) {
					console.log("Not setting gutter ok icon: Digest mismatch at range " + JSON.stringify(rng));
				}
				this.prefix_stale = true;
				return;
			}
			const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
			let ok_kind: ok_kind;
			if (contents.stage == "full-buffer-fragment-lax-ok") { ok_kind = "light-checked"; }
			else { ok_kind = "checked"; }
			const msg: StatusOkMessage = {
				uri: this.uri,
				ok_kind: ok_kind,
				ranges: [ok_range]
			};
			this.connection.sendStatusOk(msg);
			return;
		}
		if (contents.stage == "full-buffer-fragment-started") {
			const rng = contents.ranges;
			const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
			const msg = {
				uri: this.uri,
				ranges: [ok_range]
			};
			this.connection.sendStatusInProgress(msg);
			//If there's any proof state for the range that's starting
			//clear it, because we'll get updates from fstar_ide
			this.clearIdeProofProofStateAtRange(rng);
			return;
		}
		if (contents.stage == "full-buffer-fragment-failed") {
			const rng = contents.ranges;
			const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
			const msg = {
				uri: this.uri,
				ranges: [ok_range]
			};
			this.connection.sendStatusFailed(msg);
			return;
		}
	}

	// If we get errors and warnings from F*, we send them to VSCode as diagnostics,
	// which will show them as squiggles in the editor.
	private handleIdeDiagnostics(response: IdeDiagnostic[]) {
		function ideErrorLevelAsDiagnosticSeverity(level: string): DiagnosticSeverity {
			switch (level) {
				case "warning": return DiagnosticSeverity.Warning;
				case "error": return DiagnosticSeverity.Error;
				case "info": return DiagnosticSeverity.Information;
				default: return DiagnosticSeverity.Error;
			}
		}
		if (!response || !(Array.isArray(response))) {
			this.connection.sendAlert({ message: "Got invalid response to ide diagnostics request: " + JSON.stringify(response), uri: this.uri });
			return;
		}
		const diagnostics: Diagnostic[] = [];
		response.forEach((err) => {
			let diag: Diagnostic | undefined = undefined;
			let shouldAlertErrorInDifferentFile = false;
			err.ranges.forEach((rng) => {
				if (!diag) {
					// First range for this error, construct the diagnostic message.
					let mainRange;
					const relatedInfo = [];
					if (rng.fname != "<input>") {
						// This is a diagnostic raised on another file
						shouldAlertErrorInDifferentFile = err.level == "error";
						const defaultRange: FStarRange = {
							fname: "<input>",
							beg: [1, 0],
							end: [1, 0]
						};
						mainRange = defaultRange;
						const relationLocation = {
							uri: this.qualifyFilename(rng.fname, this.uri),
							range: fstarRangeAsRange(rng)
						};
						const ri: DiagnosticRelatedInformation = {
							location: relationLocation,
							message: "related location"
						};
						relatedInfo.push(ri);
					}
					else {
						mainRange = rng;
					}
					diag = {
						severity: ideErrorLevelAsDiagnosticSeverity(err.level),
						range: fstarRangeAsRange(mainRange),
						message: err.message,
						relatedInformation: relatedInfo
					};
				} else if (diag) {
					const relatedLocation = {
						uri: this.qualifyFilename(rng.fname, this.uri),
						range: fstarRangeAsRange(rng)
					};
					const relatedInfo: DiagnosticRelatedInformation = {
						location: relatedLocation,
						message: "related location"
					};
					if (diag.relatedInformation) {
						diag.relatedInformation.push(relatedInfo);
					}
				}
			});
			if (shouldAlertErrorInDifferentFile) {
				this.connection.sendAlert({ message: err.message, uri: this.uri });
			}
			if (diag) {
				diagnostics.push(diag);
			}
		});
		this.fstar_diagnostics = this.fstar_diagnostics.concat(diagnostics);
	}

	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		const doc = this.lastPendingChange ?? this.currentDoc;
		const word = findWordAtPosition(doc, textDocumentPosition.position);
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
		const textDoc = this.lastPendingChange ?? this.currentDoc;
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
		const word = findWordAtPosition(textDoc, textDocumentPosition.position);
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
		const textDoc = this.lastPendingChange ?? this.currentDoc;
		const word = findWordAtPosition(textDoc, defParams.position);
		// The filename '<input>' here must be exactly the same the we used in the full buffer request.
		const result = await this.fstar.lookupQuery('<input>', defParams.position, word.word);
		if (result.status !== 'success') return [];
		if (result.response.kind === 'symbol') {
			const defined_at = result.response["defined-at"];
			const range = fstarRangeAsRange(defined_at);
			return [{
				targetUri: this.qualifyFilename(defined_at.fname, textDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		} else if (result.response.kind === 'module') {
			const range: Range = {start: {line: 0, character: 0}, end: {line: 0, character: 0}};
			return [{
				targetUri: this.qualifyFilename(result.response.path, textDoc.uri),
				targetRange: range,
				targetSelectionRange: range,
			}];
		}
	}

	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		const textDoc = this.lastPendingChange ?? this.currentDoc;
		const text = textDoc.getText(formatParams.range);
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
