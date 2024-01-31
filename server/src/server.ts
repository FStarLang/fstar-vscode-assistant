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
import { formatIdeProofState, formatIdeSymbol, fstarRangeAsRange, mkPosition, qualifyFilename, rangeAsFStarRange } from './utils';
import { ClientConnection } from './client_connection';
import { FStarConnection, StreamedResult } from './fstar_connection';
import { FStar } from './fstar';
import { FStarRange, IdeAutoCompleteOptions, IdeSymbol, IdeProofState, IdeProgress, IdeError, FullBufferQueryResponse } from './fstar_messages';
import { handleIdeAutoComplete, handleIdeDiagnostics, handleIdeProgress, handleIdeProofState, handleIdeSymbol } from './fstar_handlers';

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
		this.documents.onDidOpen(e => {
			this.onOpenHandler(e.document);
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
		this.connection.conn.onDidChangeConfiguration(_change => {
			this.updateConfigurationSettings();
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

	// Lookup the symbol table for the symbol under the cursor
	findIdeSymbolAtPosition(textDocument: TextDocument, position: Position) {
		const uri = textDocument.uri;
		const doc_state = this.getDocumentState(uri);
		if (!doc_state) { return; }
		const wordAndRange = this.findWordAtPosition(textDocument, position);
		const range = wordAndRange.range;
		const rangeKey = JSON.stringify(range);
		const result = doc_state.hover_symbol_info.get(rangeKey);
		return { symbolInfo: result, wordAndRange: wordAndRange };
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
	async validateFStarDocument(textDocument: TextDocument, kind: 'full' | 'lax' | 'cache' | 'reload-deps', withSymbols: boolean, lax?: 'lax') {
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
		this.handleFullBufferResponse(response, textDocument, lax);
	}

	async validateFStarDocumentToPosition(textDocument: TextDocument, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }) {
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
		this.handleFullBufferResponse(response, textDocument, lax);
	}

	private async handleFullBufferResponse(promise: StreamedResult<FullBufferQueryResponse>, textDocument: TextDocument, lax?: 'lax') {
		let [response, next_promise] = await promise;

		// full-buffer queries result in a stream of IdeProgress responses.
		// These are returned as `StreamedResult` values which are essentially
		// tuples with the next promise as the second element of the tuple. We
		// therefore handle each of these progress messages here until there is
		// no longer a next promise.
		//
		// TODO(klinvill): could add a nicer API to consume a streamed result without needing to continuosly check next_promise.
		while (next_promise) {
			this.handleSingleFullBufferResponse(response, textDocument, lax);
			[response, next_promise] = await next_promise;
		}
		this.handleSingleFullBufferResponse(response, textDocument, lax);
	}

	private async handleSingleFullBufferResponse(response: FullBufferQueryResponse, textDocument: TextDocument, lax?: 'lax') {
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
				// TODO(klinvill): can symbol messages be sent in response
				// to a request that results in streams (like full-buffer
				// queries)? I seem to be seeing this for some full-buffer
				// queries.
				handleIdeSymbol(textDocument, response.response as IdeSymbol, this);
			}
		} else {
			console.warn(`Unhandled full-buffer response: ${JSON.stringify(response)}`);
		}
	}

	// Sending a LookupQuery to fstar_lax_ide, if flycheck is enabled
	// otherwise send lookup queries to fstar_ide
	async requestSymbolInfo(textDocument: TextDocument, position: Position, wordAndRange: WordAndRange) {
		const uri = textDocument.uri;
		const filePath = URI.parse(uri).fsPath;
		const lax = this.configurationSettings.flyCheck ? 'lax' : undefined;
		const fstar_conn = this.getFStarConnection(textDocument, lax);
		if (!fstar_conn) { return; }
		const result = await fstar_conn.lookupQuery(filePath, position, wordAndRange.word, wordAndRange.range);
		handleIdeSymbol(textDocument, result.response as IdeSymbol, this);
	}


	// Lookup any auto-complete information for the symbol under the cursor
	findIdeAutoCompleteAtPosition(textDocument: TextDocument, position: Position) {
		const uri = textDocument.uri;
		const doc_state = this.getDocumentState(uri);
		if (!doc_state) { return; }
		const wordAndRange = this.findWordAtPosition(textDocument, position);
		const auto_completions = [];
		if (wordAndRange.word.length > 3) {
			for (const [key, value] of doc_state.auto_complete_info) {
				if (wordAndRange.word.startsWith(key)) {
					auto_completions.push({ key, value });
				}
			}
		}
		return {
			auto_completions,
			wordAndRange
		};
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
			hover_symbol_info: new Map(),
			hover_proofstate_info: new Map(),
			auto_complete_info: new Map(),
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
		this.updateConfigurationSettings();
		if (this.hasConfigurationCapability) {
			// Register for all configuration changes.
			this.connection.conn.client.register(DidChangeConfigurationNotification.type, undefined);
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

	// The document state holds a table of completions for words in the document
	// This table is populated lazily by autocomplete calls to fstar_lax_ide
	// We look in the table for a best match for the current word at the cursor
	// If we find a match, we return it
	// If the best match is not a perfect match (i.e., it doesn't match the word
	// at the cursor exactly), we send we send a request to fstar_lax_ide
	// for the current word, for use at subsequent completion calls
	private onCompletion(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
		const doc = this.getDocument(textDocumentPosition.textDocument.uri);
		if (!doc) { return []; }
		// move the cursor back one character to get the word before the cursor
		const position = Position.create(
			textDocumentPosition.position.line,
			textDocumentPosition.position.character - 1);
		const autoCompleteResponses = this.findIdeAutoCompleteAtPosition(doc, position);
		if (!autoCompleteResponses) {
			return [];
		}
		let shouldSendRequest = false;
		let bestMatch: { key: string; value: IdeAutoCompleteOptions } = { key: "", value: [] };
		autoCompleteResponses.auto_completions.forEach((response) => {
			if (response.key.length > bestMatch.key.length) {
				bestMatch = response;
			}
		});
		shouldSendRequest = bestMatch.key != autoCompleteResponses.wordAndRange.word;
		if (shouldSendRequest) {
			const wordAndRange = autoCompleteResponses.wordAndRange;
			// Don't send requests for very short words
			if (wordAndRange.word.length < 2) return [];
			const lax = this.configurationSettings.flyCheck ? "lax" : undefined;
			const fstar_conn = this.getFStarConnection(doc, lax);
			// TODO(klinvill): should we await the response here? The autocomplete response table is populated asynchronously.
			const responses = fstar_conn?.autocompleteRequest(wordAndRange.word);
			responses?.then(rs => handleIdeAutoComplete(doc, rs.response as IdeAutoCompleteOptions, this));
		}
		const items: CompletionItem[] = [];
		// TODO(klinvill): maybe replace this with a map() call?
		bestMatch.value.forEach((response) => {
			const data = response;
			// vscode replaces the word at the cursor with the completion item
			// but its notion of word is the suffix of the identifier after the last dot
			// so the completion we provide is the suffix of the identifier after the last dot
			const label = response[2].lastIndexOf('.') > 0 ? response[2].substring(response[2].lastIndexOf('.') + 1) : response[2];
			const item: CompletionItem = {
				label: label,
				kind: CompletionItemKind.Method,
				data: data
			};
			items.push(item);
		});
		return items;
	}

	// The onHover handler is called when the user hovers over a symbol
	// The interface requires us to return a Hover object *synchronously*
	// However, our communication with fstar.exe is asynchronous
	// So we ask F* to resolve the symbol asynchronously, and return a dummy Hover
	// object at first.
	// When F* responds, the symbol table map gets populated
	// Then, if we get a hover request for the same symbol, we can return the
	// actual Hover object.
	// Sometimes, the symbol table map gets populated before the hover request,
	// notably in the case where we have tactic proof state information to display
	// for that line. In that case, we just return the Hover object immediately.
	//
	// Note: There are some problems with this, because as the document changes,
	// we should invalidate the symbol table map. But we don't do that yet.
	// I plan to adjust the F* IDE protocol so that it can send us a symbol table
	// map for every declaration that the lax F* process sees. We can use that table
	// to resolve symbols, but even that is problematic because the lax F* also caches
	// the AST of the document rather than the raw textual positions. So we'll have to
	// do some work to make this work well.
	private onHover(textDocumentPosition: TextDocumentPositionParams): Hover {
		const textDoc = this.getDocument(textDocumentPosition.textDocument.uri);
		if (!textDoc) { return { contents: "" }; }
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
		// Otherwise, check if we have symbol information for this symbol
		const symbol = this.findIdeSymbolAtPosition(textDoc, textDocumentPosition.position);
		if (!symbol) { return { contents: "No symbol info" }; }
		if (symbol && symbol.symbolInfo) {
			return formatIdeSymbol(symbol.symbolInfo);
		}
		this.requestSymbolInfo(textDoc, textDocumentPosition.position, symbol.wordAndRange);
		return { contents: { kind: 'plaintext', value: "Looking up:" + symbol.wordAndRange.word } };
	}

	// The onDefinition handler is called when the user clicks on a symbol
	// It's very similar to the onHover handler, except that it returns a
	// LocationLink object instead of a Hover object
	private onDefinition(defParams: DefinitionParams): LocationLink[] {
		const textDoc = this.getDocument(defParams.textDocument.uri);
		if (!textDoc) { return []; }
		const symbol = this.findIdeSymbolAtPosition(textDoc, defParams.position);
		if (!symbol) { return []; }
		if (symbol && symbol.symbolInfo) {
			const sym = symbol.symbolInfo;
			const defined_at = sym["defined-at"];
			if (!defined_at) { return []; }
			const range = fstarRangeAsRange(defined_at);
			const uri = qualifyFilename(defined_at.fname, textDoc.uri, this);
			const location = LocationLink.create(uri, range, range);
			return [location];
		}
		this.requestSymbolInfo(textDoc, defParams.position, symbol.wordAndRange);
		return [];
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

	private onRestartRequest(uri: any) {
		// console.log("Received restart request with parameters: " + uri);
		const textDocument = this.getDocument(uri);
		this.onRestartHandler(textDocument);
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

	private async onTextDocChangedRequest(params: any) {
		const uri = params[0];
		const range: { line: number; character: number }[] = params[1];
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		// TODO(klinvill): It looks like this function can only be called for
		// non-lax checking. Is that correct?
		const fstar_conn = this.getFStarConnection(textDocument);
		fstar_conn?.cancelRequest(range[0]);
	}

	private onKillAndRestartSolverRequest(uri: any) {
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		// TODO(klinvill): It looks like this function only restarts the
		// standard F* solver (not the lax one), is this the desired behavior?
		const fstar_conn = this.getFStarConnection(textDocument);
		fstar_conn?.restartSolver();
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
	// A symbol-info table populated by fstar_lax_ide for onHover and onDefinition requests
	hover_symbol_info: Map<string, IdeSymbol>;
	// A proof-state table populated by fstar_ide when running tactics, displayed in onHover
	hover_proofstate_info: Map<number, IdeProofState>;
	// A table of auto-complete responses
	auto_complete_info: Map<string, IdeAutoCompleteOptions>;
	// A flag to indicate if the prefix of the buffer is stale
	prefix_stale: boolean;
}

type DocumentStates = Map<string, DocumentState>

interface WordAndRange {
	word: string;
	range: FStarRange;
}
