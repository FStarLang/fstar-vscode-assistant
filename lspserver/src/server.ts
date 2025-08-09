import {
	TextDocuments,
	InitializeParams,
	DidChangeConfigurationNotification,
	TextDocumentSyncKind,
	InitializeResult,
	WorkspaceFolder,
	Connection,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { defaultSettings, fstarVSCodeAssistantSettings } from './settings';
import { FStar } from './fstar';
import { statusNotification, killAndRestartSolverNotification, restartNotification, verifyToPositionNotification, killAllNotification, getTranslatedFstRequest, GetTranslatedFstParams, GetTranslatedFstResponse } from './fstarLspExtensions';
import { DocumentState, DocumentStateEventHandlers, FStarDocumentState } from './documentState';
import { CDocumentState } from './cDocumentState';

// LSP Server
//
// The LSP Server interfaces with both the Client (e.g. the vscode extension)
// and the F* processes that are used to check files. It is started run using
// the `server.run()` method. The `Connection` and text document manager
// are passed in as arguments, following the dependency injection pattern. This
// allows for easier mocking out of these connections which in turn allows for
// easier testing.
export class Server {
	documentStates = new Map<string, DocumentState>();
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
			const docState = this.getDocumentState(change.document.uri);
			if (this.configurationSettings.verifyOnSave) {
				// TODO: sequence with c2pulse
				docState?.verifyAll();
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
		this.connection.onInitialized(() => void this.onInitializedHandler());
		// We don't do anything special when the configuration changes
		this.connection.onDidChangeConfiguration(() => void this.updateConfigurationSettings());
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
		this.connection.onRequest(getTranslatedFstRequest,
			({uri, position}) => this.getDocumentState(uri)?.getTranslatedFst(position));
		this.connection.onNotification(restartNotification, ({uri}) =>
			void this.onRestartRequest(uri));
		this.connection.onNotification(killAndRestartSolverNotification, ({uri}) =>
			void this.getDocumentState(uri)?.killAndRestartSolver());
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
		this.documentStates.forEach((docState) => docState.setDebug(!!settings.debug));
	}

	private eventHandlers: DocumentStateEventHandlers = {
		sendDiagnostics: (params) => void this.connection.sendDiagnostics(params),
		sendStatus: (params) => void this.connection.sendNotification(statusNotification, params),
	};

	async refreshDocumentState(uri: string) {
		const doc = this.documents.get(uri);
		if (!doc || this.documentStates.has(uri)) return;

		const filePath = URI.parse(uri).fsPath;
		const fstar_config = await FStar.getFStarConfig(filePath,
			this.workspaceFolders, this.connection, this.configurationSettings);

		if (filePath.endsWith('.c') || filePath.endsWith('.h')) {
			const docState = new CDocumentState(doc, fstar_config, this.eventHandlers, this.configurationSettings);
			if (docState) this.documentStates.set(uri, docState);
		} else {
			const docState = FStarDocumentState.make(doc, fstar_config, this.eventHandlers,
				this.configurationSettings);
			if (docState) this.documentStates.set(uri, docState);
		}
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
		this.hasConfigurationCapability = !!capabilities.workspace?.configuration;
		this.hasWorkspaceFolderCapability = !!capabilities.workspace?.workspaceFolders;
		this.hasDiagnosticRelatedInformationCapability = !!capabilities.textDocument?.publishDiagnostics?.relatedInformation;
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
			docState.verifyAll();
		} else {
			docState.verifyAll({flycheckOnly: true});
		}
	}

	private async onRestartRequest(uri: string) {
		if (!this.documents.get(uri)) return;
		this.documentStates.get(uri)?.dispose();
		this.documentStates.delete(uri);
		await this.refreshDocumentState(uri);
		// And ask the lax fstar process to verify it
		this.getDocumentState(uri)?.verifyAll({flycheckOnly: true});
	}

	private onKillAllRequest() {
		const oldDocStates = [...this.documentStates.values()];
		this.documentStates = new Map();
		for (const v of oldDocStates) {
			v.dispose();
		}
	}
}