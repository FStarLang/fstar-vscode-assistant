/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	Diagnostic,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult,
	Position
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';

import path = require('path');

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			}
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// The example settings
interface ExampleSettings {
	maxNumberOfProblems: number;
}

// The global settings, used when the `workspace/configuration` request is not supported by the client.
// Please note that this is not the case when using this server with the client provided in this example
// but could happen with other clients.
const defaultSettings: ExampleSettings = { maxNumberOfProblems: 1000 };
let globalSettings: ExampleSettings = defaultSettings;

// Cache the settings of all open documents
const documentSettings: Map<string, Thenable<ExampleSettings>> = new Map();

interface IDERequest {
	query_id : number;
}

interface IDEResponse {
	kind:     string;
	query_id: number;
	status:   string;
	response: string;
}

enum IDEStateEnum {
   Initializing,
   Ready,
   Dead
}

interface Pos {
	line: number;
	column: number
}

interface Range {
	start_pos: Pos;
	end_pos: Pos
}

// Cache the settings of all open documents
interface IDEState {
	fstar_ide: cp.ChildProcess;
	last_seen_doc_contents: string;
	last_query_id: number;
	gutter_decorations: Range []
}

const documentState: Map<string, IDEState> = new Map();

connection.onDidChangeConfiguration(change => {
	if (hasConfigurationCapability) {
		// Reset all cached document settings
		documentSettings.clear();
	} else {
		globalSettings = <ExampleSettings>(
			(change.settings.languageServerExample || defaultSettings)
		);
	}

	// Revalidate all open text documents
    //documents.all().forEach(validateFTextDocument);
});

function getDocumentSettings(resource: string): Thenable<ExampleSettings> {
	if (!hasConfigurationCapability) {
		return Promise.resolve(globalSettings);
	}
	let result = documentSettings.get(resource);
	if (!result) {
		result = connection.workspace.getConfiguration({
			scopeUri: resource,
			section: 'languageServerExample'
		});
		documentSettings.set(resource, result);
	}
	return result;
}

function mkPosition(pos: number []) {
	//F* line numbers begin at 1; unskew
	return Position.create(pos[0] - 1, pos[1]);
}

function handleOneResponseForDocument(textDocument: TextDocument, data:string) {
	console.log("handleOneResponse: <" +data+ ">");
	if (data == "") { return; }
	const r = JSON.parse(data);
	if (r.kind == "protocol-info") {
		console.log ("FStar ide returned protocol info " + r.kind);
	}
	else if (r.kind == "message" && r.level == "progress") {
		const contents = r.contents;
		if (contents.stage == "full-buffer-fragment-ok" ) {
			const rng = contents.ranges;
			const ok_range = [rng.beg[0] - 1, rng.beg[1], rng.end[0] - 1, rng.end[1]];
			console.log("Setting ok_range: " + ok_range);
			connection.sendNotification("custom/statusOk", ok_range);
		}
	}
	else if (r.kind == "response" && r.status == "failure") {
		if (!r.response) { return; }
		r.response.forEach((err : {message:string; ranges:[{beg:number[]; end:number[]}]}) => {
			const rng = err.ranges[0];
			const diag = {
				severity: DiagnosticSeverity.Error,
				range: {
					start: mkPosition(rng.beg),
					end: mkPosition(rng.end)
				},
				message: err.message
			};
			connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[diag]});				
		}); 
	}
	else if (r.kind == "response" && r.status == "success") { 
		return;
	}
	else {
		console.log("Unhandled response");
	}
}

function handleFStarResponseForDocument(textDocument: TextDocument, data:string) {
	console.log("Got raw response: " +typeof(data) + " :: " +data);
	const lines = data.toString().split('\n');
	lines.forEach(line => { handleOneResponseForDocument(textDocument, line);  });
}

function sendRequestForDocument(textDocument : TextDocument, msg:any) {
	const doc_state = documentState.get(textDocument.uri);
	if (!doc_state) {
		return;
	}
	else {
		const qid = doc_state.last_query_id;
		doc_state.last_query_id = qid + 1;
		msg["query-id"] = '' + (qid + 1);
		const text = JSON.stringify(msg);
		console.log("Sending message: " +text);
		doc_state?.fstar_ide?.stdin?.write(text);
		doc_state?.fstar_ide?.stdin?.write("\n");
	}
}

documents.onDidOpen( e => {
	const textDocument = e.document;
    const filePath = URI.parse(textDocument.uri);
	const docDirectory = path.dirname(filePath.fsPath);
	const filename = path.basename(filePath.fsPath);
	console.log("onDidOpen(dir="+docDirectory+", file="+filename+"\n contents={"+textDocument.getText()+"}");
	const fstar_ide = cp.spawn("fstar.exe", ["--ide", filename], {cwd:docDirectory});
	documentState.set(textDocument.uri, { fstar_ide: fstar_ide, last_seen_doc_contents: textDocument.getText(), last_query_id: 0, gutter_decorations:[] });
	fstar_ide.stdin.setDefaultEncoding('utf-8');
	fstar_ide.stdout.on('data', (data) => { handleFStarResponseForDocument(e.document, data); });
	const vfs_add = {"query":"vfs-add","args":{"filename":null,"contents":textDocument.getText()}};
	sendRequestForDocument(textDocument, vfs_add);
	console.log("Finished onDidOpen");
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateFStarDocument(change.document);
});

async function validateFStarDocument(textDocument: TextDocument): Promise<void> {
	console.log("ValidateFStarDocument( " + textDocument.uri + ")");
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
    connection.sendNotification("custom/statusClear", []);
	// const push_context = { query:"push", args:{kind:"full", code:textDocument.getText(), line:0, column:0} };
	const push_context = { query:"full-buffer", args:{kind:"full", code:textDocument.getText(), line:0, column:0} };
	sendRequestForDocument(textDocument, push_context);
}

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		return [];
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
