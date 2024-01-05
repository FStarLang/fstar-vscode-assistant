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
import { AlertMessage, ClientConnection } from './client_connection';
import { FStar } from './fstar';
import { handleFStarResponseForDocumentFactory } from './fstar_handlers';

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
			this.killFStarProcessesForDocument(e.document);
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
		// https://javascript.info/bind for a better explanation.
		this.connection.conn.onInitialize(this.onInitialize.bind(this));
		this.connection.conn.onInitialized(this.onInitializedHandler.bind(this));
		// We don't do anything special when the configuration changes
		this.connection.conn.onDidChangeConfiguration(_change => {
			this.updateConfigurationSettings();
		});
		this.connection.conn.onDidChangeWatchedFiles(_change => {
			// Monitored files have change in VSCode
			// connection.console.log('We received an file change event');
		});
		this.connection.conn.onCompletion(this.onCompletion.bind(this));
		// This handler resolves additional information for the item selected in
		// the completion list.
		this.connection.conn.onCompletionResolve(
			(item: CompletionItem): CompletionItem => {
				return item;
			}
		);
		this.connection.conn.onHover(this.onHover.bind(this));
		this.connection.conn.onDefinition(this.onDefinition.bind(this));
		this.connection.conn.onDocumentRangeFormatting(this.onDocumentRangeFormatting.bind(this));

		// Custom events
		this.connection.conn.onRequest("fstar-vscode-assistant/verify-to-position", this.onVerifyToPositionRequest.bind(this));
		this.connection.conn.onRequest("fstar-vscode-assistant/lax-to-position", this.onLaxToPositionRequest.bind(this));
		this.connection.conn.onRequest("fstar-vscode-assistant/restart", this.onRestartRequest.bind(this));
		this.connection.conn.onRequest("fstar-vscode-assistant/text-doc-changed", this.onTextDocChangedRequest.bind(this));
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-and-restart-solver", this.onKillAndRestartSolverRequest.bind(this));
		this.connection.conn.onRequest("fstar-vscode-assistant/kill-all", this.onKillAllRequest.bind(this));
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

	// Some utilities to send messages to fstar_ide or fstar_lax_ide
	// Sending a request to either fstar_ide or fstar_lax_ide
	// Wraps the request with a fresh query-id
	sendRequestForDocument(textDocument: TextDocument, msg: any, lax?: 'lax') {
		const doc_state = this.getDocumentState(textDocument.uri);
		if (!doc_state) {
			return;
		}
		const fstar = this.getFStar(textDocument, lax);
		if (!fstar) {
			return;
		}
		else {
			const qid = doc_state.last_query_id;
			doc_state.last_query_id = qid + 1;
			msg["query-id"] = '' + (qid + 1);
			const text = JSON.stringify(msg);
			if (this.configurationSettings.debug) {
				console.log(">>> " + text);
			}
			if (fstar.proc.exitCode != null) {
				if (lax) {
					if (doc_state.alerted_fstar_lax_process_exited) { return; }
					doc_state.alerted_fstar_lax_process_exited = true;
					const msg: AlertMessage = {
						uri: textDocument.uri,
						message: "ERROR: F* flycheck process exited with code " + fstar.proc.exitCode
					};
					this.connection.sendAlert(msg);
					console.error(msg);
				}
				else {
					if (doc_state.alerted_fstar_process_exited) { return; }
					doc_state.alerted_fstar_process_exited = true;
					const msg: AlertMessage = {
						uri: textDocument.uri,
						message: "ERROR: F* checker process exited with code " + fstar.proc.exitCode
					};
					this.connection.sendAlert(msg);
					console.error(msg);
				}
				return;
			}
			else {
				try {
					fstar.proc?.stdin?.write(text);
					fstar.proc?.stdin?.write("\n");
				} catch (e) {
					const msg = "ERROR: Error writing to F* process: " + e;
					console.error(msg);
					this.connection.sendAlert({ uri: textDocument.uri, message: msg });
				}
			}
		}
	}

	// Sending a FullBufferQuery to fstar_ide or fstar_lax_ide
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
		const fstar = this.getFStar(textDocument, lax);
		if (fstar?.supportsFullBuffer) {
			const push_context: FullBufferQuery = {
				query: "full-buffer",
				args: {
					kind,
					"with-symbols": withSymbols,
					code: textDocument.getText(),
					line: 0,
					column: 0
				}
			};
			this.sendRequestForDocument(textDocument, push_context, lax);
		}
	}

	validateFStarDocumentToPosition(textDocument: TextDocument, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }) {
		this.pendingChangeEvents = []; // Clear pending change events, since we're checking it now
		// console.log("ValidateFStarDocumentToPosition( " + textDocument.uri + ", " + kind);
		this.connection.sendClearDiagnostics({ uri: textDocument.uri });
		// If this is non-lax requests, send a status clear messages to VSCode
		// to clear the gutter icons and error squiggles
		// They will be reported again if the document is not verified
		const doc_state = this.getDocumentState(textDocument.uri);
		if (doc_state) {
			doc_state.prefix_stale = false;
		}
		this.connection.sendStatusClear({ uri: textDocument.uri });
		const ranges = [Range.create(mkPosition([0, 0]), mkPosition([position.line, 0]))];
		this.connection.sendStatusStarted({ uri: textDocument.uri, ranges: ranges });
		const fstar = this.getFStar(textDocument);
		if (fstar && fstar.supportsFullBuffer) {
			const push_context: FullBufferQuery = {
				query: "full-buffer",
				args: {
					kind: kind,
					"with-symbols": false,
					code: textDocument.getText(),
					line: 0,
					column: 0,
					"to-position": position
				}
			};
			this.sendRequestForDocument(textDocument, push_context);
		}
	}

	// Sending a LookupQuery to fstar_lax_ide, if flycheck is enabled
	// otherwise send lookup queries to fstar_ide
	requestSymbolInfo(textDocument: TextDocument, position: Position, wordAndRange: WordAndRange): void {
		const uri = textDocument.uri;
		const filePath = URI.parse(uri).fsPath;
		const query: LookupQuery = {
			query: "lookup",
			args: {
				context: "code",
				symbol: wordAndRange.word,
				"requested-info": ["type", "documentation", "defined-at"],
				location: {
					filename: filePath,
					line: position.line + 1,
					column: position.character
				},
				"symbol-range": wordAndRange.range
			}
		};
		this.sendRequestForDocument(textDocument, query, this.configurationSettings.flyCheck ? 'lax' : undefined);
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

	killFStarProcessesForDocument(textDocument: TextDocument) {
		const docState = this.getDocumentState(textDocument.uri);
		if (!docState) return;
		docState.fstar.proc.kill();
		docState.fstar_lax.proc.kill();
		this.documentStates.delete(textDocument.uri);
	}

	// Get the FStar instance for the given document
	getFStar(textDocument: TextDocument, lax?: 'lax'): FStar | undefined {
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
	}

	async refreshDocumentState(textDocument: TextDocument) {
		const fstar = FStar.fromInferredConfig(textDocument, this.workspaceFolders, this.connection, this.configurationSettings);
		// Failed to start F*
		if (!fstar) { return; }

		// We can just re-use the configuration used for the non-lax F* instance.
		const fstar_lax = FStar.trySpawnFstar(fstar.config, textDocument, this.configurationSettings, this.connection, 'lax');
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

		// Set the event handlers for the fstar processes
		const handleFStarResponseForDocument = handleFStarResponseForDocumentFactory();

		fstar.proc.stdin?.setDefaultEncoding('utf-8');
		fstar.proc.stdout?.on('data', (data) => { handleFStarResponseForDocument(textDocument, data, false, this); });
		fstar.proc.stderr?.on('data', (data) => { console.error("fstar stderr: " + data); });
		fstar_lax.proc.stdin?.setDefaultEncoding('utf-8');
		fstar_lax.proc.stdout?.on('data', (data) => { handleFStarResponseForDocument(textDocument, data, true, this); });
		fstar_lax.proc.stderr?.on('data', (data) => { console.error("fstar lax stderr: " + data); });

		// Send the initial dummy vfs-add request to the fstar processes
		const filePath = URI.parse(textDocument.uri);
		const vfs_add: VfsAdd = { "query": "vfs-add", "args": { "filename": filePath.fsPath, "contents": textDocument.getText() } };
		this.sendRequestForDocument(textDocument, vfs_add);
		this.sendRequestForDocument(textDocument, vfs_add, 'lax');
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
		let bestMatch: { key: string; value: IdeAutoCompleteResponses } = { key: "", value: [] };
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
			const autoCompletionRequest: AutocompleteRequest = {
				"query": "autocomplete",
				"args": {
					"partial-symbol": wordAndRange.word,
					"context": "code"
				}
			};
			this.sendRequestForDocument(doc, autoCompletionRequest, this.configurationSettings.flyCheck ? "lax" : undefined);
		}
		const items: CompletionItem[] = [];
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

	private onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams) {
		const textDoc = this.getDocument(formatParams.textDocument.uri);
		if (!textDoc) { return []; }
		const text = textDoc.getText(formatParams.range);
		// call fstar.exe synchronously to format the text
		const fstarConfig = FStar.getFStarConfig(textDoc, this.workspaceFolders, this.connection, this.configurationSettings);
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
		this.killFStarProcessesForDocument(textDocument);
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
		const cancelRequest: CancelRequest = {
			query: "cancel",
			args: {
				"cancel-line": range[0].line + 1,
				"cancel-column": range[0].character
			}
		};
		this.sendRequestForDocument(textDocument, cancelRequest);
	}

	private onKillAndRestartSolverRequest(uri: any) {
		const textDocument = this.getDocument(uri);
		if (!textDocument) { return; }
		const documentState = this.getDocumentState(textDocument.uri);
		if (!documentState) { return; }
		const fstar = documentState.fstar;

		fstar.killZ3SubProcess(this.configurationSettings);

		// Wait for a second for processes to die before restarting the solver
		setTimeout(() => {
			this.sendRequestForDocument(textDocument, { query: "restart-solver", args: {} });
		}, 1000);
	}

	private onKillAllRequest(params: any) {
		this.documentStates.forEach((docState, uri) => {
			const textDoc = this.getDocument(uri);
			if (!textDoc) { return; }
			this.killFStarProcessesForDocument(textDoc);
		});
		return;
	}
}


////////////////////////////////////////////////////////////////////////////////////
// The state of the LSP server
////////////////////////////////////////////////////////////////////////////////////

interface DocumentState {
	// The main fstar.exe process for verifying the current document
	fstar: FStar;
	alerted_fstar_process_exited: boolean;
	fstar_diagnostics: Diagnostic[];

	// The fstar.exe process for quickly handling on-change events, symbol lookup etc
	fstar_lax: FStar;
	alerted_fstar_lax_process_exited: boolean;
	fstar_lax_diagnostics: Diagnostic[];

	// Every query sent to fstar_ide & fstar_lax_ide is assigned a unique id
	last_query_id: number;
	// A symbol-info table populated by fstar_lax_ide for onHover and onDefinition requests
	hover_symbol_info: Map<string, IdeSymbol>;
	// A proof-state table populated by fstar_ide when running tactics, displayed in onHover
	hover_proofstate_info: Map<number, IdeProofState>;
	// A table of auto-complete responses
	auto_complete_info: Map<string, IdeAutoCompleteResponses>;
	// A flag to indicate if the prefix of the buffer is stale
	prefix_stale: boolean;
}

type DocumentStates = Map<string, DocumentState>

interface WordAndRange {
	word: string;
	range: FStarRange;
}
