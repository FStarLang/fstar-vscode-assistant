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
	_Connection
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';

import { defaultSettings, fstarVSCodeAssistantSettings } from './settings';
import { formatIdeProofState, fstarRangeAsRange, mkPosition, qualifyFilename, rangeAsFStarRange } from './utils';
import { ClientConnection } from './client_connection';
import { FStarConnection, StreamedResult } from './fstar_connection';
import { FStar } from './fstar';
import { FStarRange, IdeAutoCompleteOptions, IdeSymbol, IdeProofState, IdeProgress, IdeError, FullBufferQueryResponse } from './fstar_messages';
import { handleIdeDiagnostics, handleIdeProgress, handleIdeProofState } from './fstar_handlers';

// LSP Server
//
// The LSP Server interfaces with both the Client (e.g. the vscode extension)
// and the F* processes that are used to check files. It is started run using
// the `server.run()` method. The `ClientConnection` and text document manager
// are passed in as arguments, following the dependency injection pattern. This
// allows for easier mocking out of these connections which in turn allows for
// easier testing.
export class Server {
	documentStates: DocumentStates;
	// Text document manager.
	documents: TextDocuments<TextDocument>;
	// All the open workspace folders
	workspaceFolders: WorkspaceFolder[];
	configurationSettings: fstarVSCodeAssistantSettings;
	// Connection to the client (the extension in the IDE)
	connection: ClientConnection;
	// We don't want to send too many requests to fstar.exe, so we batch them up
	// and send only the most recent one.
	pendingChangeEvents: TextDocument[];
	changeDispatcher: NodeJS.Timeout;

	// Client (e.g. extension) capabilities
	hasConfigurationCapability: boolean;
	hasWorkspaceFolderCapability: boolean;
	hasDiagnosticRelatedInformationCapability: boolean;

	constructor(connection: ClientConnection, documents: TextDocuments<TextDocument>) {
		this.documentStates = new Map<string, DocumentState>();
		this.documents = documents;
		this.workspaceFolders = [];
		this.configurationSettings = defaultSettings;
		this.connection = connection;
		this.pendingChangeEvents = [];

		this.hasConfigurationCapability = false;
		this.hasWorkspaceFolderCapability = false;
		this.hasDiagnosticRelatedInformationCapability = false;

		// We don't want to send too many requests to fstar.exe, so we batch them up
		// and send only the most recent one every 1 second.
		this.changeDispatcher = setInterval(() => {
			if (this.pendingChangeEvents.length > 0) {
				const doc = this.pendingChangeEvents.pop();
				if (!doc) return;
				this.pendingChangeEvents = [];
				if (this.configurationSettings.flyCheck) {
					this.validateFStarDocument(doc, "lax", false, "lax");
				}
				this.validateFStarDocument(doc, "cache", false);
			}
		}, 1000);

		// The main entry point when a document is opened
		//  * find the .fst.config.json file for the document in the workspace, otherwise use a default config
		//  * spawn 2 fstar processes: one for typechecking, one lax process for fly-checking and symbol lookup
		//  * set event handlers to read the output of the fstar processes
		//  * send the current document to both processes to start typechecking
		this.documents.onDidOpen(async e => {
			await this.onOpenHandler(e.document);
		});

		// Only keep settings for open documents
		this.documents.onDidClose(e => {
			this.closeFStarProcessesForDocument(e.document);
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
		this.documents.onDidChangeContent(change => {
			this.pendingChangeEvents.push(change.document);
		});

		this.documents.onDidSave(change => {
			if (this.configurationSettings.verifyOnSave) {
				this.pendingChangeEvents = []; //don't send any pending change events
				this.validateFStarDocument(change.document, "full", false);
				if (this.configurationSettings.flyCheck) {
					this.validateFStarDocument(change.document, "lax", true, "lax"); //retain flycheck markers for the suffix
				}
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
		this.connection.conn.onCompletion(textDocumentPosition => this.onCompletion(textDocumentPosition));
		// This handler resolves additional information for the item selected in
		// the completion list.
		this.connection.conn.onCompletionResolve(
			(item: CompletionItem): CompletionItem => {
				return item;
			}
		);
		this.connection.conn.onHover(textDocumentPosition => this.onHover(textDocumentPosition));
		this.connection.conn.onDefinition(defParams => this.onDefinition(defParams));
		this.connection.conn.onDocumentRangeFormatting(formatParams => this.onDocumentRangeFormatting(formatParams));

		// Custom events
		this.connection.conn.onRequest("fstar-vscode-assistant/verify-to-position", params => this.onVerifyToPositionRequest(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/lax-to-position", params => this.onLaxToPositionRequest(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/restart", uri => this.onRestartRequest(uri));
		this.connection.conn.onRequest("fstar-vscode-assistant/text-doc-changed", params => this.onTextDocChangedRequest(params));
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-and-restart-solver", uri => this.onKillAndRestartSolverRequest(uri));
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-all", params => this.onKillAllRequest(params));
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

	// Find the word at the given position in the given document
	// (used to find the symbol under the cursor)
	findWordAtPosition(textDocument: TextDocument, position: Position): WordAndRange {
		const text = textDocument.getText();
		const offset = textDocument.offsetAt(position);
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
		const range = Range.create(textDocument.positionAt(start), textDocument.positionAt(start + word.length));
		return { word: word, range: rangeAsFStarRange(range) };
	}

	// Lookup the proof state table for the line at the cursor
	findIdeProofStateAtLine(textDocument: TextDocument, position: Position) {
		const uri = textDocument.uri;
		const doc_state = this.getDocumentState(uri);
		if (!doc_state) { return; }
		const rangeKey = position.line + 1;
		return doc_state.hover_proofstate_info.get(rangeKey);
	}

	clearIdeProofProofStateAtRange(textDocument: TextDocument, range: FStarRange) {
		const uri = textDocument.uri;
		const doc_state = this.getDocumentState(uri);
		if (!doc_state) { return; }
		const line_ctr = range.beg[0];
		const end_line_ctr = range.end[0];
		for (let i = line_ctr; i <= end_line_ctr; i++) {
			doc_state.hover_proofstate_info.delete(i);
		}
	}

	// Send a FullBufferQuery to validate the given document.
	validateFStarDocument(textDocument: TextDocument, kind: 'full' | 'lax' | 'cache' | 'reload-deps', withSymbols: boolean, lax?: 'lax') {
		// console.log("ValidateFStarDocument( " + textDocument.uri + ", " + kind + ", lax=" + lax + ")");
		this.connection.sendClearDiagnostics({ uri: textDocument.uri });
		if (!lax) {
			// If this is non-lax requests, send a status clear messages to VSCode
			// to clear the gutter icons and error squiggles
			// They will be reported again if the document is not verified
			const doc_state = this.getDocumentState(textDocument.uri);
			if (doc_state) {
				doc_state.prefix_stale = false;
			}
			this.connection.sendStatusClear({ uri: textDocument.uri });
			const ranges = [Range.create(mkPosition([0, 0]), mkPosition([textDocument.lineCount, 0]))];
			if (kind == "full") { this.connection.sendStatusStarted({ uri: textDocument.uri, ranges: ranges }); }
		}
		const fstar_conn = this.getFStarConnection(textDocument, lax);
		if (!fstar_conn) { return; }

		const response = fstar_conn.fullBufferRequest(textDocument.getText(), kind, withSymbols);
		this.handleFullBufferResponse(response, textDocument, lax).catch(() => {});
	}

	validateFStarDocumentToPosition(textDocument: TextDocument, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }) {
		this.pendingChangeEvents = []; // Clear pending change events, since we're checking it now
		// console.log("ValidateFStarDocumentToPosition( " + textDocument.uri + ", " + kind);
		this.connection.sendClearDiagnostics({ uri: textDocument.uri });
		// If this is non-lax requests, send a status clear messages to VSCode
		// to clear the gutter icons and error squiggles
		// They will be reported again if the document is not verified
		//
		// TODO(klinvill): in `validateFStarDocument` this is done only for
		// non-lax requests. Should a similar check be done here? The previous
		// implementation of `validateFStarDocumentToPosition` implies that this
		// function will never be called for lax requests. Is that true?
		const lax = undefined;
		const doc_state = this.getDocumentState(textDocument.uri);
		if (doc_state) {
			doc_state.prefix_stale = false;
		}
		this.connection.sendStatusClear({ uri: textDocument.uri });
		const ranges = [Range.create(mkPosition([0, 0]), mkPosition([position.line, 0]))];
		this.connection.sendStatusStarted({ uri: textDocument.uri, ranges: ranges });


		const fstar_conn = this.getFStarConnection(textDocument, lax);
		if (!fstar_conn) { return; }

		const response = fstar_conn.partialBufferRequest(textDocument.getText(), kind, position);
		this.handleFullBufferResponse(response, textDocument, lax).catch(() => {});
	}

	private async handleFullBufferResponse(promise: Promise<StreamedResult<FullBufferQueryResponse>>, textDocument: TextDocument, lax?: 'lax') {
		let [response, next_promise] = await promise;

		// full-buffer queries result in a stream of IdeProgress responses.
		// These are returned as `StreamedResult` values which are essentially
		// tuples with the next promise as the second element of the tuple. We
		// therefore handle each of these progress messages here until there is
		// no longer a next promise.
		//
		// TODO(klinvill): could add a nicer API to consume a streamed result
		// without needing to continuously check next_promise.
		while (next_promise) {
			this.handleSingleFullBufferResponse(response, textDocument, lax);
			// eslint-disable-next-line @typescript-eslint/no-floating-promises
			[response, next_promise] = await next_promise;
		}
		this.handleSingleFullBufferResponse(response, textDocument, lax);
	}

	private handleSingleFullBufferResponse(response: FullBufferQueryResponse, textDocument: TextDocument, lax?: 'lax') {
		if (response.kind === 'message' && response.level === 'progress') {
			handleIdeProgress(textDocument, response.contents as IdeProgress, lax === 'lax', this);
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
			handleIdeProofState(textDocument, response.contents as IdeProofState, this);
		} else if (response.kind === 'response') {
			// TODO(klinvill): if a full-buffer query is interrupted, a null response seems to be sent along with a status. Is this always the behavior that occurs?
			if (!response.response) {
				console.info("Query cancelled");
			} else if (Array.isArray(response.response)) {
				handleIdeDiagnostics(textDocument, response.response as IdeError[], lax === 'lax', this);
			} else {
				// ignore
			}
		} else {
			console.warn(`Unhandled full-buffer response: ${JSON.stringify(response)}`);
		}
	}

	closeFStarProcessesForDocument(textDocument: TextDocument) {
		const docState = this.getDocumentState(textDocument.uri);
		if (!docState) return;
		docState.fstar.close();
		docState.fstar_lax.close();
		this.documentStates.delete(textDocument.uri);
	}

	// Get the FStarConnection instance for the given document
	getFStarConnection(textDocument: TextDocument, lax?: 'lax'): FStarConnection | undefined {
		const uri = textDocument.uri;
		const doc_state = this.getDocumentState(uri);
		if (lax) {
			return doc_state?.fstar_lax;
		} else {
			return doc_state?.fstar;
		}
	}

	async onOpenHandler(textDocument: TextDocument) {
		await this.updateConfigurationSettings();
		await this.refreshDocumentState(textDocument);

		const docState = this.getDocumentState(textDocument.uri);
		if (docState === undefined) { return; }

		// And ask the main fstar process to verify it
		if (this.configurationSettings.verifyOnOpen) {
			this.validateFStarDocument(textDocument, "full", false);
		}

		if (this.configurationSettings.flyCheck) {
			// And ask the lax fstar process to verify it
			this.validateFStarDocument(textDocument, "lax", true, "lax");
		}
	}

	async updateConfigurationSettings() {
		const settings = await this.connection.conn.workspace.getConfiguration('fstarVSCodeAssistant');
		if (settings.debug) {
			console.log("Server got settings: " + JSON.stringify(settings));
		}
		this.configurationSettings = settings;

		// FStarConnection objects store their own debug flag, so we need to update them all with the latest value.
		this.documentStates.forEach((docState, uri) => {
			docState.fstar.debug = settings.debug;
			docState.fstar_lax.debug = settings.debug;
		});
	}

	async refreshDocumentState(textDocument: TextDocument) {
		const fstar_config = await FStar.getFStarConfig(textDocument, this.workspaceFolders, this.connection, this.configurationSettings);
		const filePath = URI.parse(textDocument.uri);

		const fstar = FStarConnection.tryCreateFStarConnection(fstar_config, filePath,  this.configurationSettings.debug);
		// Failed to start F*
		if (!fstar) { return; }

		const fstar_lax = FStarConnection.tryCreateFStarConnection(fstar_config, filePath,  this.configurationSettings.debug, 'lax');
		// Failed to start F* lax
		if (!fstar_lax) { return; }

		// Initialize the document state for this doc
		this.documentStates.set(textDocument.uri, {
			fstar: fstar,
			alerted_fstar_process_exited: false,
			fstar_diagnostics: [],
			fstar_lax: fstar_lax,
			alerted_fstar_lax_process_exited: false,
			fstar_lax_diagnostics: [],
			last_query_id: 0,
			hover_proofstate_info: new Map(),
			prefix_stale: false,
		});

		// Send the initial dummy vfs-add request to the fstar processes.
		fstar.vfsAddRequest(filePath.fsPath, textDocument.getText())
			.catch(e => console.error(`vfs-add request to F* process failed: ${e}`));
		fstar_lax.vfsAddRequest(filePath.fsPath, textDocument.getText())
			.catch(e => console.error(`vfs-add request to lax F* process failed: ${e}`));
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

	private async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		const doc = this.getDocument(textDocumentPosition.textDocument.uri);
		if (!doc) return;
		const lax = this.configurationSettings.flyCheck ? 'lax' : undefined;
		const conn = this.getFStarConnection(doc, lax);
		if (!conn) return;
		const word = this.findWordAtPosition(doc, textDocumentPosition.position);
		if (word.word.length < 2) return;
		const response = await conn.autocompleteRequest(word.word);
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

	// The onHover handler is called when the user hovers over a symbol
	private async onHover(textDocumentPosition: TextDocumentPositionParams): Promise<Hover | undefined> {
		const textDoc = this.getDocument(textDocumentPosition.textDocument.uri);
		if (!textDoc) return;
		// First, check if we have proof state information for this line
		const proofState = this.findIdeProofStateAtLine(textDoc, textDocumentPosition.position);
		if (proofState) {
			return {
				contents: {
					kind: 'markdown',
					value: formatIdeProofState(proofState)
				}
			};
		}
		// Otherwise, check the symbol information for this symbol
		const lax = this.configurationSettings.flyCheck ? 'lax' : undefined;
		const conn = this.getFStarConnection(textDoc, lax);
		if (!conn) return;
		const filePath = URI.parse(textDoc.uri).fsPath;
		const word = this.findWordAtPosition(textDoc, textDocumentPosition.position);
		const result = await conn.lookupQuery(filePath, textDocumentPosition.position, word.word);
		if (result.status !== 'success') return;
		return {
			contents: {
				kind: 'markdown',
				value:
					"```fstar\n" +
					result.response.name + ":\n" +
					result.response.type + "\n" +
					"```\n"
			},
		};
	}

	// The onDefinition handler is called when the user clicks on a symbol
	// It's very similar to the onHover handler, except that it returns a
	// LocationLink object instead of a Hover object
	private async onDefinition(defParams: DefinitionParams): Promise<LocationLink[]> {
		const textDoc = this.getDocument(defParams.textDocument.uri);
		if (!textDoc) { return []; }
		const lax = this.configurationSettings.flyCheck ? 'lax' : undefined;
		const conn = this.getFStarConnection(textDoc, lax);
		if (!conn) return [];
		const filePath = URI.parse(textDoc.uri).fsPath;
		const word = this.findWordAtPosition(textDoc, defParams.position);
		const result = await conn.lookupQuery(filePath, defParams.position, word.word);
		if (result.status !== 'success') return [];
		const defined_at = result.response["defined-at"];
		const range = fstarRangeAsRange(defined_at);
		return [{
			targetUri: qualifyFilename(defined_at.fname, textDoc.uri, this),
			targetRange: range,
			targetSelectionRange: range,
		}];
	}

	private async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		const textDoc = this.getDocument(formatParams.textDocument.uri);
		if (!textDoc) { return []; }
		const text = textDoc.getText(formatParams.range);
		// call fstar.exe synchronously to format the text
		const fstarConfig = await FStar.getFStarConfig(textDoc, this.workspaceFolders, this.connection, this.configurationSettings);
		const format_query = {
			"query-id": "1",
			query: "format",
			args: {
				code: text
			}
		};
		// TODO(klinvill): This interaction with the F* executable should be moved to the FStar class or file.
		const fstarFormatter =
			cp.spawnSync(fstarConfig.fstar_exe ? fstarConfig.fstar_exe : "fstar.exe",
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

	private onVerifyToPositionRequest(params: any) {
		const uri = params[0];
		const position: { line: number, character: number } = params[1];
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		this.validateFStarDocumentToPosition(textDocument, "verify-to-position", { line: position.line + 1, column: position.character });
		if (this.configurationSettings.flyCheck) {
			this.validateFStarDocument(textDocument, "lax", false, "lax"); //also flycheck, so we get status markers beyond the position too
		}
	}

	private onLaxToPositionRequest(params: any) {
		const uri = params[0];
		const position: { line: number, character: number } = params[1];
		// console.log("Received lax-to-position request with parameters: " + uri + " " + JSON.stringify(position));
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		this.validateFStarDocumentToPosition(textDocument, "lax-to-position", { line: position.line + 1, column: position.character });
		if (this.configurationSettings.flyCheck) {
			this.validateFStarDocument(textDocument, "lax", false, "lax"); //also flycheck, so we get status markers beyond the position too
		}
	}

	private async onRestartRequest(uri: any) {
		// console.log("Received restart request with parameters: " + uri);
		const textDocument = this.getDocument(uri);
		await this.onRestartHandler(textDocument);
	}

	private async onRestartHandler(textDocument?: TextDocument) {
		if (!textDocument) { return; }
		this.closeFStarProcessesForDocument(textDocument);
		await this.refreshDocumentState(textDocument);
		this.connection.sendStatusClear({ uri: textDocument.uri });
		// And ask the lax fstar process to verify it
		if (this.configurationSettings.flyCheck) {
			this.validateFStarDocument(textDocument, "lax", false, "lax");
		}
	}

	private onTextDocChangedRequest(params: any) {
		const uri = params[0];
		const range: { line: number; character: number }[] = params[1];
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		// TODO(klinvill): It looks like this function can only be called for
		// non-lax checking. Is that correct?
		const fstar_conn = this.getFStarConnection(textDocument);
		fstar_conn?.cancelRequest(range[0]);
	}

	private async onKillAndRestartSolverRequest(uri: any) {
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		// TODO(klinvill): It looks like this function only restarts the
		// standard F* solver (not the lax one), is this the desired behavior?
		const fstar_conn = this.getFStarConnection(textDocument);
		await fstar_conn?.restartSolver();
	}

	private onKillAllRequest(params: any) {
		this.documentStates.forEach((docState, uri) => {
			const textDoc = this.getDocument(uri);
			if (!textDoc) { return; }
			this.closeFStarProcessesForDocument(textDoc);
		});
		return;
	}
}


////////////////////////////////////////////////////////////////////////////////////
// The state of the LSP server
////////////////////////////////////////////////////////////////////////////////////

interface DocumentState {
	// The main fstar.exe process for verifying the current document
	fstar: FStarConnection;
	alerted_fstar_process_exited: boolean;
	fstar_diagnostics: Diagnostic[];

	// The fstar.exe process for quickly handling on-change events, symbol lookup etc
	fstar_lax: FStarConnection;
	alerted_fstar_lax_process_exited: boolean;
	fstar_lax_diagnostics: Diagnostic[];

	// Every query sent to fstar_ide & fstar_lax_ide is assigned a unique id
	last_query_id: number;
	// A proof-state table populated by fstar_ide when running tactics, displayed in onHover
	hover_proofstate_info: Map<number, IdeProofState>;
	// A flag to indicate if the prefix of the buffer is stale
	prefix_stale: boolean;
}

type DocumentStates = Map<string, DocumentState>

interface WordAndRange {
	word: string;
	range: FStarRange;
}
