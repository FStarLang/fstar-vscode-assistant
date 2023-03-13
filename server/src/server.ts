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
	Position,
	Range,
	Hover,
	Definition,
	DefinitionParams,
	WorkspaceFolder,
	LocationLink
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';

import path = require('path');

// Import fs and path modules}
import * as fs from 'fs';
import { pathToFileURL } from 'url';

// Define a function that takes a directory path and a file path
function checkFileInDirectory(dirPath : string, filePath :string) : boolean {
	// Check if dirPath is a directory using fs.stat()
	const stats = fs.statSync(dirPath);
	if (!stats || !stats.isDirectory()) {
		console.log(dirPath + ' is not a directory');
		return false;
	}

	// Get the relative path from dirPath to filePath using path.relative()
	const relativePath = path.relative(dirPath, filePath);
	console.log("Relative path of " + filePath + " from " + dirPath + " is " + relativePath);
	// Check if relativePath starts with '..' or '.'
	if (relativePath.startsWith('..')) {
		// If yes, then filePath is outside dirPath
		return false;
	} else {
		// If yes, then filePath is inside dirPath	
		return true;
	} 
}

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Messags in the small protocol running on top of LSP between the server and client
interface StatusOkMessage {
	uri: string;
	ranges: Range [];
}

interface StatusClearMessage {
	uri: string;
}

function sendStatusOk (msg : StatusOkMessage)  {
	console.log("Sending statusOk notification: " +msg);
	connection.sendNotification('custom/statusOk', msg);
}


function sendStatusClear (msg: StatusClearMessage) {
	console.log("Sending statusClear notification: " +msg);
	connection.sendNotification('custom/statusClear', msg);
}

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
let workspaceFolders : WorkspaceFolder [] = [];
const workspaceConfigs: Map<string, FStarConfig []> = new Map();

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let supportsFullBuffer = true;


// Define a function that takes a folder path and an extension
function findFilesByExtension(folderPath:string, extension:string) {
	// Read the folder contents using fs.readdir()
	const matches : string[] = [];
	const files = fs.readdirSync(folderPath);
	if (!files) {
		console.error("No files found in " + folderPath);
		return [];
	}
	// Loop over the files
	for (const file of files) {
		console.log("Checking file " + file + " for extension " + extension);
		if (file.endsWith(extension)) {
			console.log("Found config file " + file);
			// absolute path of file is folderPath + file
			matches.push(path.join(folderPath, file));
		}
	}
	return matches;
}
	
connection.onInitialize((params: InitializeParams) => {
	console.log("onInitialize!");
	const capabilities = params.capabilities;
	if (params.workspaceFolders) {
		params.workspaceFolders?.forEach(folder => {
			const folderPath = URI.parse(folder.uri).fsPath;
			const folderConfigs : FStarConfig[] = [];
			console.log("Searchig in " +folderPath + " for .fst.config.json");
			findFilesByExtension(folderPath, ".fst.config.json").forEach(configFile => {
				console.log("Found config file " + configFile);
				const contents = fs.readFileSync(configFile, 'utf8');
				console.log("File cotents: " + contents + "");
				const config = JSON.parse(contents);
				if (!config.cwd) {
					config.cwd = folderPath;
				}
				folderConfigs.push(config);
			});
			console.log("Settig workspaceConfigs for " +folderPath + " to " + JSON.stringify(folderConfigs));
			workspaceConfigs.set(folderPath, folderConfigs);			
		});
		workspaceFolders = params.workspaceFolders;
	}

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
			},
			hoverProvider: true,
			definitionProvider: true
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


// Cache the settings of all open documents
interface FStarRange {
	fname:string;
	beg: number [];
	end: number []
}

interface IdeSymbol {
	kind:'symbol';
	name:string;
	type:string;
	documentation:string;
	definition:string;
	"defined-at": FStarRange;
	"symbol-range":FStarRange;
	symbol:string;
}

interface IDEState {
	fstar_ide: cp.ChildProcess;
	fstar_lax_ide: cp.ChildProcess;
	last_query_id: number;
	hover_info: Map<string, IdeSymbol>;
}

interface FStarConfig {
	include_dirs:string [];
	options:string [];
	fstar_exe:string;
	cwd: string;
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

function mkPosition(pos: number []) : Position {
	//F* line numbers begin at 1; unskew
	return Position.create(pos[0] > 0 ? pos[0] - 1 : pos[0], pos[1]);
}

interface ProtocolInfo {
	version:number;
	features:string [];
}

function handleIdeProtocolInfo(textDocument: TextDocument, pi : ProtocolInfo) {
	console.log ("FStar ide returned protocol info");
	if (!pi.features.includes("full-buffer")) {
		supportsFullBuffer = false;
		console.log("fstar.exe does not support full-buffer queries.");
	}
} 

function handleIdeProgress(textDocument: TextDocument, contents : any) {
	if (contents.stage == "full-buffer-fragment-ok" ) {
		const rng = contents.ranges;
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			ranges: [ok_range]
		};
		sendStatusOk(msg);
	}
}

interface IdeError {
	message: string;
	level : string;
	ranges: FStarRange[];
}

function ideErrorLevelAsDiagnosticSeverity (level: string) : DiagnosticSeverity {
	switch (level) {
		case "warning": return DiagnosticSeverity.Warning;
		case "error": return DiagnosticSeverity.Error;
		case "info": return DiagnosticSeverity.Information;
		default: return DiagnosticSeverity.Error;
	}
}

function rangeOfFStarRange (rng: FStarRange) : Range {
	return Range.create(mkPosition(rng.beg), mkPosition(rng.end));
}

function rangeAsFStarRange (rng: Range) : FStarRange {
	return {
		fname: "",
		beg: [rng.start.line + 1, rng.start.character],
		end: [rng.end.line + 1, rng.end.character]
	};
}

function handleIdeSymbol(textDocument: TextDocument, response : IdeSymbol) {
	console.log("Got ide symbol " +JSON.stringify(response));
	const rng = JSON.stringify(response["symbol-range"]);
	const hoverMap = documentState.get(textDocument.uri)?.hover_info;
	if (hoverMap) {
		hoverMap.set(rng, response);
	}
}

function handleIdeDiagnostics (textDocument : TextDocument, response : IdeError []) {
	if (!response || !(Array.isArray(response))) { return; }
	response.forEach((err) => {
		err.ranges.forEach ((rng) => {
			const diag = {
				severity: ideErrorLevelAsDiagnosticSeverity(err.level),
				range: {
					start: mkPosition(rng.beg),
					end: mkPosition(rng.end)
				},
				message: err.message
			};
			connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[diag]});
		});
	}); 
}

function handleOneResponseForDocument(textDocument: TextDocument, data:string) {
	console.log("handleOneResponse: <" +data+ ">");
	if (data == "") { return; }
	const r = JSON.parse(data);
	if (r.kind == "protocol-info") {
		return handleIdeProtocolInfo(textDocument, r);
	}
	else if (r.kind == "message" && r.level == "progress") {
		console.log("Got progress message: " +data);
		return handleIdeProgress(textDocument, r.contents);
	}
	else if (r.kind == "response" && r.status == "failure") {
		if (!r.response) { return; }
		return handleIdeDiagnostics(textDocument, r.response);
	}
	else if (r.kind == "response" && r.status == "success") { 
		if (!r.response) { return; }
		return handleIdeDiagnostics(textDocument, r.response);
	}
	else {
		console.log("Unhandled response: " + r.kind);
	}
}

function handleFStarResponseForDocument(textDocument: TextDocument, data:string) {
	// console.log("Got raw response: " +typeof(data) + " :: " +data);
	const lines = data.toString().split('\n');
	lines.forEach(line => { handleOneResponseForDocument(textDocument, line);  });
}

function handleOneLaxResponseForDocument(textDocument: TextDocument, data:string) {
	// console.log("handleOneResponse: <" +data+ ">");
	if (data == "") { return; }
	const r = JSON.parse(data);
	if (r.kind == "protocol-info") {
		return handleIdeProtocolInfo(textDocument, r);
	}
	else if (r.kind == "message" && r.level == "progress") {
		return;
	}
	else if (r.kind == "response" && r.status == "failure") {
		if (!r.response) { return; }
		return handleIdeDiagnostics(textDocument, r.response);
	}
	else if (r.kind == "response" && r.status == "success") { 
		if (!r.response) { return; }
		if (r.response.kind == "symbol") {
			return handleIdeSymbol(textDocument, r.response);
		}
		return handleIdeDiagnostics(textDocument, r.response);
	}
	else {
		console.log("Unhandled response: " + r.kind);
	}
}
function handleLaxFStarResponseForDocument(textDocument: TextDocument, data:string) {
	// // console.log("Got raw response: " +typeof(data) + " :: " +data);
	const lines = data.toString().split('\n');
	lines.forEach(line => { handleOneLaxResponseForDocument(textDocument, line);  });
}

function sendRequestForDocument(textDocument : TextDocument, msg:any, lax: boolean) {
	const doc_state = documentState.get(textDocument.uri);
	if (!doc_state) {
		return;
	}
	else {
		const qid = doc_state.last_query_id;
		doc_state.last_query_id = qid + 1;
		msg["query-id"] = '' + (qid + 1);
		const text = JSON.stringify(msg);
		const proc = lax ? doc_state.fstar_lax_ide : doc_state.fstar_ide;
		// console.log("Sending message: " +text);
		proc?.stdin?.write(text);
		proc?.stdin?.write("\n");
	}
}

function sendLaxRequestForDocument(textDocument : TextDocument, msg:any) {
	sendRequestForDocument(textDocument, msg, true);
}

function sendFullRequestForDocument(textDocument : TextDocument, msg:any) {
	sendRequestForDocument(textDocument, msg, false);
}

function findConfigFile(e : TextDocument) : FStarConfig {
	const filePath = URI.parse(e.uri).fsPath;
	let result : FStarConfig = {
		options : [],
		include_dirs : [],
		fstar_exe : "fstar.exe",
		cwd: path.dirname(filePath)
	};
	workspaceFolders.find((folder) => {
		const folderPath = URI.parse(folder.uri).fsPath;
		console.log("Checking folder: " +folderPath+  " for file: " +filePath);
		if (checkFileInDirectory(folderPath, filePath)) {
			const r = workspaceConfigs.get(folderPath);	
			if (r) {
				result = r[0];
			}
			console.log("Found config: " +JSON.stringify(result));
		}
	});
	return result;
}

documents.onDidOpen( e => {
	const textDocument = e.document;
	const fstarConfig = findConfigFile(e.document);
	const filePath = URI.parse(textDocument.uri);
	const docDirectory = path.dirname(filePath.fsPath);
	const filename = path.basename(filePath.fsPath);
	console.log("onDidOpen(dir="+docDirectory+", file="+filename);
	const options = ["--ide", filename];
	fstarConfig.options.forEach((opt) => { options.push(opt); });
	fstarConfig.include_dirs.forEach((dir) => { options.push("--include"); options.push(dir); });
	console.log("Spawning fstar with options: " +options);
	const fstar_ide =
		cp.spawn(
			fstarConfig.fstar_exe,
			options,
			{cwd:fstarConfig.cwd});
	options.push("--lax");
	const fstar_lax_ide =
		cp.spawn(
			fstarConfig.fstar_exe,
			options,
			{cwd:fstarConfig.cwd});
	documentState.set(textDocument.uri, { 
						fstar_ide: fstar_ide,
						fstar_lax_ide: fstar_lax_ide,
						last_query_id: 0,
						hover_info: new Map()
					});
	fstar_ide.stdin.setDefaultEncoding('utf-8');
	fstar_ide.stdout.on('data', (data) => { handleFStarResponseForDocument(e.document, data); });
	fstar_ide.stderr.on('data', (data) => { console.log("fstar stderr: " +data); });
	const vfs_add = {"query":"vfs-add","args":{"filename":null,"contents":textDocument.getText()}};
	sendFullRequestForDocument(textDocument, vfs_add);
	validateFStarDocument(textDocument, "full");

	fstar_lax_ide.stdin.setDefaultEncoding('utf-8');
	fstar_lax_ide.stdout.on('data', (data) => { handleLaxFStarResponseForDocument(e.document, data); });
	fstar_lax_ide.stderr.on('data', (data) => { console.log("fstar lax stderr: " +data); });
	sendLaxRequestForDocument(textDocument, vfs_add);
});

// Only keep settings for open documents
documents.onDidClose(e => {
	documentSettings.delete(e.document.uri);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	laxValidateFStarDocument(change.document);
	validateFStarDocument(change.document, "cache");
});

documents.onDidSave(change => {
	validateFStarDocument(change.document, "full");
});

async function validateFStarDocument(textDocument: TextDocument, kind:'full'|'cache'): Promise<void> {
	console.log("ValidateFStarDocument( " + textDocument.uri + ")");
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
	sendStatusClear({uri:textDocument.uri});
	if (supportsFullBuffer) {
		const push_context = { query:"full-buffer", args:{kind:kind, code:textDocument.getText(), line:0, column:0} };
		sendFullRequestForDocument(textDocument, push_context);
	}
}

async function laxValidateFStarDocument(textDocument: TextDocument): Promise<void> {
	console.log("LaxValidateFStarDocument( " + textDocument.uri + ")");
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
	// sendStatusClear({uri:textDocument.uri});
	if (supportsFullBuffer) {
		const push_context = { query:"full-buffer", args:{kind:"full", code:textDocument.getText(), line:0, column:0} };
		sendLaxRequestForDocument(textDocument, push_context);
	}
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

interface WordAndRange {
	word: string;
	range: FStarRange;
}

function findWordAtPosition(textDocument: TextDocument, position: Position) : WordAndRange
 {
	const text = textDocument.getText();
	const offset = textDocument.offsetAt(position);
	let start = text.lastIndexOf(' ', offset) + 1;
	for (let i = offset; i >= start; i--) {
		if (text.at(i)?.search(/\W/) === 0) {
			start = i + 1;
			break;
		}
	}
	const end = text.substring(offset).search(/\W/) + offset;
	const word = text.substring(start, end > start ? end : undefined);
	const range = Range.create(textDocument.positionAt(start), textDocument.positionAt(end));
	return {word: word, range: rangeAsFStarRange(range)};
}

function findIdeSymbolAtPosition(textDocument: TextDocument, position: Position) {
	const uri = textDocument.uri;
	const doc_state = documentState.get(uri);
	if (!doc_state) { return; }
	const wordAndRange = findWordAtPosition(textDocument, position);
	const range = wordAndRange.range;
	const rangeKey = JSON.stringify(range);
	console.log("Looking for symbol info at " + rangeKey);
	const result = doc_state.hover_info.get(rangeKey);
	return { symbolInfo: result, wordAndRange: wordAndRange };
}

function requestSymbolInfo(textDocument: TextDocument, position: Position, wordAndRange : WordAndRange) : void {
	const uri = textDocument.uri;
	const filePath = URI.parse(uri).fsPath;
	const query = {
		query:"lookup",
		args: {
			context:"code",
			symbol:wordAndRange.word,
			"requested-info":["type","documentation","defined-at"],
			location:{
				filename:filePath,
				line:position.line+1,
				column:position.character
			},
			"symbol-range" : wordAndRange.range
		}
	};
	sendLaxRequestForDocument(textDocument, query);
}

connection.onHover(
	(textDocumentPosition: TextDocumentPositionParams): Hover => {
		console.log("Hover: " + textDocumentPosition.position.line + 
					", " + textDocumentPosition.position.character+ 
					" in " + textDocumentPosition.textDocument.uri);
		const textDoc = documents.get(textDocumentPosition.textDocument.uri);
		if (!textDoc) { return {contents: ""}; }
		const symbol = findIdeSymbolAtPosition(textDoc, textDocumentPosition.position);
		if (!symbol) { return {contents: "No symbol info"}; }	
		if (symbol && symbol.symbolInfo) { //} && result.symbol == hoverInfo.word) { 
			return {
				contents: {
					kind:'plaintext',
					value:symbol.symbolInfo.name + "\n" + symbol.symbolInfo.type
				}
			};
		}
		requestSymbolInfo(textDoc, textDocumentPosition.position, symbol.wordAndRange);
		return {contents: {kind:'plaintext', value:"Loading hover at: " + symbol.wordAndRange.word}};
	}
);

connection.onDefinition((defParams : DefinitionParams) => {
	const textDoc = documents.get(defParams.textDocument.uri);
	if (!textDoc) { return []; }
	const symbol = findIdeSymbolAtPosition(textDoc, defParams.position);
	if (!symbol) { return []; }
	if (symbol && symbol.symbolInfo) {
		const defined_at = symbol.symbolInfo["defined-at"];
		if (!defined_at) { return []; }		
		const range = rangeOfFStarRange(defined_at);
		const uri = defined_at.fname == "<input>" ? textDoc.uri : pathToFileURL(defined_at.fname).toString();
		const location = LocationLink.create(uri, range, range);
		return [location];
	}
	requestSymbolInfo(textDoc, defParams.position, symbol.wordAndRange);
	return [];
 });

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
