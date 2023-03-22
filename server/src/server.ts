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
	LocationLink,
	DocumentRangeFormattingParams,
	TextEdit
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

////////////////////////////////////////////////////////////////////////////////////
// The state of the LSP server
////////////////////////////////////////////////////////////////////////////////////

interface IDEState {
	// The main fstar.exe process for verifying the current document
	fstar_ide: cp.ChildProcess;
	// The fstar.exe process for quickly handling on-change events, symbol lookup etc
	fstar_lax_ide: cp.ChildProcess;
	// Every query sent to fstar_ide & fstar_lax_ide is assigned a unique id
	last_query_id: number;
	// A symbol-info table populated by fstar_lax_ide for onHover and onDefinition requests
	hover_symbol_info: Map<string, IdeSymbol>;
	// A proof-state table populated by fstar_ide when running tactics, displayed in onHover
	hover_proofstate_info: Map<number, IdeProofState>;
	// A table of auto-complete responses
	auto_complete_info: Map<string, IdeAutoCompleteResponses>;
	// A flag to indicate if the prefix of the buffer is stale
	prefix_stale : boolean;
}

const documentStates: Map<string, IDEState> = new Map();

////////////////////////////////////////////////////////////////////////////////////
// Workspace config files
////////////////////////////////////////////////////////////////////////////////////

// The type of an .fst.config.json file
interface FStarConfig {
	include_dirs:string []; // --include paths
	options:string [];      // other options to be passed to fstar.exe
	fstar_exe:string;       // path to fstar.exe
	cwd: string;            // working directory for fstar.exe (usually not specified; defaults to workspace root)
}

// All the open workspace folders
let workspaceFolders : WorkspaceFolder [] = [];

// Config files in the workspace root folders
const workspaceConfigs: Map<string, FStarConfig> = new Map();

////////////////////////////////////////////////////////////////////////////////////
// Response messages in the IDE protocol that fstar.exe uses
////////////////////////////////////////////////////////////////////////////////////

// ProtocolInfo: The first response from fstar.exe when it is first launched
interface ProtocolInfo {
	kind:'protocol-info';
	version:number;
	features:string [];
}

// An FStarRange is a range of positions in some source file
// A position is a line number and a column number
// A quirk is that the line number is 1-based, but the column number is 0-based
// In contrast, the LSP protocol uses 0-based line and column numbers
// So, we need to convert between the two
interface FStarRange {
	fname:string;
	beg: number [];
	end: number []
}

// IdeSymbol: This message is sent from fstar.exe in response to a
// request for a onHover or onDefnition symbol lookup
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

// IdeProofState: fstar.exe sends informative messages when running tactics
// The server does not explicitly request the proof state---these messages
// are just sent by fstar.exe as a side-effect of running tactics
// The server stores the proof state in a table, and uses it to display
// the proof state in the onHover message
interface IdeProofState {
	label:string; // User-provided label, e.g., dump "A"
	depth:number; // The depth of this dump message (not displayed)
	urgency:number; // Urgency (not displayed)
	goals: IdeProofStateContextualGoal []; // The main proof state
	"smt-goals" : IdeProofStateContextualGoal[]; // SMT goals
	location: FStarRange; // The location of the tactic that triggered a proof state dump
}

// A Contextual goal is a goal with all the hypothesis in context
interface IdeProofStateContextualGoal {
	hyps: {
		name:string;
		type:string;
	} [];
	goal: IdeProofStateGoal;
}

// A goal itself is a witness and a type, with a label
interface IdeProofStateGoal {
	witness:string;
	type:string;
	label:string;
}

// IDEError: fstar.exe sends this message when reporting errors and warnings
interface IdeError {
	message: string;
	level : 'warning' | 'error' | 'info';
	ranges: FStarRange[];
}

interface IdeCodeFragment {
	code: string;
	range: FStarRange;
}

interface IdeProgress {
	stage: 'full-buffer-fragment-ok' | 'full-buffer-fragment-lax-ok' | 'full-buffer-fragment-started';
	ranges: FStarRange;
	"code-fragment"?: IdeCodeFragment
}


// An auto-complete response
type IdeAutoCompleteResponse = [number, string, string];
type IdeAutoCompleteResponses = IdeAutoCompleteResponse[];
type IdeQueryResponseTypes = IdeSymbol | IdeError[] | IdeAutoCompleteResponses;

// A query response envelope
interface IdeQueryResponse {
	'query-id': string;
	kind: 'protocol-info' | 'response' | 'message';
	status?: 'success' | 'failure';
	level?: 'progress' | 'proof-state';
	response?: IdeQueryResponseTypes;
	contents?: IdeProofState | IdeSymbol | IdeProgress;
}

type IdeResponse = IdeQueryResponse | ProtocolInfo

function decideIdeReponseType (response: IdeQueryResponseTypes) : 'symbol' | 'error' | 'auto-complete' {
	if (Array.isArray(response)) {
		if (response.length > 0 && Array.isArray(response[0])) {
			return "auto-complete";
		}
		else {
			return "error";
		}
	}
	else {
		return "symbol";
	}
}

////////////////////////////////////////////////////////////////////////////////////
// Request messages in the IDE protocol that fstar.exe uses
////////////////////////////////////////////////////////////////////////////////////

// The first request from LSP to fstar.exe is a vfs-add, just to record that a file
// has been opened. The filename is usually null. It's not clear that this message
// is actually required, however, fstar-mode.el sends it, so we do too.
interface VfsAdd {
	query: 'vfs-add';
	args: { 
		filename: string | null; 
		contents: string
	};
}

// On document open, at each change event, and on document save
// fstar.exe is sent a FullBufferQuery
//
// Note, there is no 'lax' kind: A query is a lax check if it is sent to fstar_lax_ide
//
// On document open:
//    A 'full' query is sent to both fstar_ide and fstar_lax_ide
//
// On document change:
//    A 'full' query is sent to fstar_lax_ide, which responds with any errors and warnings
//
//    A 'cache' query is sent to fstar_ide, which responds with the prefix of the buffer
//    that remains verifed
//
// On document save:
//    A 'full' query is sent to fstar_ide to re-verify the entire document
//
// It's the job of fstar.exe to deal with incrementality. It does that by maintaining its
// own internal state and only checking the part of the buffer that has changed.
interface FullBufferQuery {
	query: 'full-buffer';
	args:{
		kind:'full' | 'cache' | 'reload-deps' | 'verify-to-position' | 'lax-to-position';
		code:string;
		line:number;
		column:number
		"to-position" ?: {
			line:number;
			column:number
		}
	} 
}

// A LookupQuery is sent to fstar_lax_ide to get symbol information for onHover and onDefinition
interface LookupQuery {
	query: 'lookup';
	args: {
		context:'code';
		symbol:string;
		"requested-info":('type' | 'documentation' | 'defined-at') [];
		// The exact position at which the user hovered
		location:{
			filename:string;
			line:number;
			column:number;
		},
		// The range of the word at which the user hovered
		// fstar.exe echoes this back when it responds
		// and we use this to lookup the symbol table when
		// the user hovers or requests the definition of that word
		"symbol-range" : FStarRange
	}
}

// A Cancel message is sent to fstar_ide when to document changes at a given range, to stop it
// from verifying the part of the buffer that has changed
interface CancelRequest {
	query: 'cancel';
	args: {
		"cancel-line":number;
		"cancel-column":number
	}
}

// A request for autocompletion
interface AutocompleteRequest {
	query: 'autocomplete';
	args: {
		"partial-symbol":string;
		context:'code'
	}
}

// Some utilities to send messages to fstar_ide or fstar_lax_ide
// Sending a request to either fstar_ide or fstar_lax_ide
// Wraps the request with a fresh query-id
function sendRequestForDocument(textDocument : TextDocument, msg:any, lax?:'lax') {
	const doc_state = documentStates.get(textDocument.uri);
	if (!doc_state) {
		return;
	}
	else {
		const qid = doc_state.last_query_id;
		doc_state.last_query_id = qid + 1;
		msg["query-id"] = '' + (qid + 1);
		const text = JSON.stringify(msg);
		const proc = lax ? doc_state.fstar_lax_ide : doc_state.fstar_ide;
		console.log(">>> " +text);
		proc?.stdin?.write(text);
		proc?.stdin?.write("\n");
	}
}


// Sending a FullBufferQuery to fstar_ide or fstar_lax_ide
function validateFStarDocument(textDocument: TextDocument,kind:'full'|'cache'|'reload-deps', lax?:'lax') {
	// console.log("ValidateFStarDocument( " + textDocument.uri + ", " + kind + ", lax=" + lax + ")");
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
	if (!lax) {
		// If this is non-lax requests, send a status clear messages to VSCode
		// to clear the gutter icons and error squiggles
		// They will be reported again if the document is not verified
		const doc_state = documentStates.get(textDocument.uri);
		if (doc_state) {
			doc_state.prefix_stale = false;
		}
		sendStatusClear({uri:textDocument.uri});
	}
	if (supportsFullBuffer) {
		const push_context : FullBufferQuery = { 
			query:"full-buffer",
			args:{
				kind:kind,
				code:textDocument.getText(),
				line:0,
				column:0
			}
		};
		sendRequestForDocument(textDocument, push_context, lax);
	}
}

function validateFStarDocumentToPosition(textDocument: TextDocument,kind:'verify-to-position'|'lax-to-position', position:{line:number, column:number}) {
	// console.log("ValidateFStarDocumentToPosition( " + textDocument.uri + ", " + kind);
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
	// If this is non-lax requests, send a status clear messages to VSCode
	// to clear the gutter icons and error squiggles
	// They will be reported again if the document is not verified
	const doc_state = documentStates.get(textDocument.uri);
	if (doc_state) {
		doc_state.prefix_stale = false;
	}
	sendStatusClear({uri:textDocument.uri});
	if (supportsFullBuffer) {
		const push_context : FullBufferQuery = { 
			query:"full-buffer",
			args:{
				kind:kind,
				code:textDocument.getText(),
				line:0,
				column:0,
				"to-position":position
			}
		};
		sendRequestForDocument(textDocument, push_context);
	}
}

interface WordAndRange {
	word: string;
	range: FStarRange;
}

// Sending a LookupQuery to fstar_lax_ide
function requestSymbolInfo(textDocument: TextDocument, position: Position, wordAndRange : WordAndRange) : void {
	const uri = textDocument.uri;
	const filePath = URI.parse(uri).fsPath;
	const query : LookupQuery = {
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
	sendRequestForDocument(textDocument, query, 'lax');
}

////////////////////////////////////////////////////////////////////////////////////
// Messages in a small custom protocol between this server and the client
// (running on top of LSP)
////////////////////////////////////////////////////////////////////////////////////

// A message to clear all gutter icons for the document with the given URI
interface StatusClearMessage {
	uri: string;
}

// A message to set the background color of chunk that is being verified
interface StatusStartedMessage {
	uri: string;
	ranges: Range []; // A VSCode range, not an FStarRange
}

// A message to dislay check-mark gutter icons for the document of the given URI
// at the given ranges
interface StatusOkMessage {
	uri: string;
	lax: boolean;
	ranges: Range []; // A VSCode range, not an FStarRange
}

// A message to clear hourglass gutter icons for the document of the given URI
// at the given ranges
interface StatusFailedMessage {
	uri: string;
	ranges: Range []; // A VSCode range, not an FStarRange
}
////////////////////////////////////////////////////////////////////////////////////
// PATH and URI Utilities
////////////////////////////////////////////////////////////////////////////////////

// Checks if filePath is includes in the cone rooted at dirPath
// Used to check if a file is in the workspace
function checkFileInDirectory(dirPath : string, filePath :string) : boolean {
	// Check if dirPath is a directory using fs.stat()
	const stats = fs.statSync(dirPath);
	if (!stats || !stats.isDirectory()) {
		console.log(dirPath + ' is not a directory');
		return false;
	}

	// Get the relative path from dirPath to filePath using path.relative()
	const relativePath = path.relative(dirPath, filePath);
	// console.log("Relative path of " + filePath + " from " + dirPath + " is " + relativePath);
	// Check if relativePath starts with '..' or '.'
	if (relativePath.startsWith('..')) {
		// If yes, then filePath is outside dirPath
		return false;
	} else {
		// If yes, then filePath is inside dirPath	
		return true;
	} 
}


// Finds all files in a folder whose name has `extension` as a suffix
// Returns an array of absolute paths of the files
// Used to find all config files in the workspace
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
		// console.log("Checking file " + file + " for extension " + extension);
		if (file.endsWith(extension)) {
			// console.log("Found config file " + file);
			// absolute path of file is folderPath + file
			matches.push(path.join(folderPath, file));
		}
	}
	return matches;
}

// Finds the .fst.config.json for a given file
// by searching the workspace root folders for a *.fst.config.json file
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
		// console.log("Checking folder: " +folderPath+  " for file: " +filePath);
		if (checkFileInDirectory(folderPath, filePath)) {
			const r = workspaceConfigs.get(folderPath);	
			if (r) {
				result = r;
			}
			// console.log("Found config: " +JSON.stringify(result));
		}
	});
	return result;
}
////////////////////////////////////////////////////////////////////////////////////
// Symbol table and proof state utilities
////////////////////////////////////////////////////////////////////////////////////

// Print a single ContextualGoal to show in a hover message
function formatProofStateContextualGoal(goal: IdeProofStateContextualGoal) : string {
	let result = "";
	for (const hyp of goal.hyps) {
		result += hyp.name + " : " + hyp.type + "\n";
	}
	result += "------------------ " + goal.goal.witness + "\n";
	result += goal.goal.type;
	return result;
}

// Print an array of ContextualGoals to show in a hover message
function formatContextualGoalArray(goals: IdeProofStateContextualGoal[]) : string {
	let result = "";
	let goal_ctr = 1;
	const n_goals = goals.length;
	goals.forEach((g) => {
		result += "Goal " + goal_ctr + " of " + n_goals + " :\n";
		result += "```fstar\n" + formatProofStateContextualGoal(g) + "\n```\n\n";
		goal_ctr++;
	});
	return result;
}

// Print the entire proof state to show in a hover message
function formatIdeProofState(ps: IdeProofState) : string {
	let result = "### Proof state \n";
	result += "(" + ps.label + ")\n";
	if (ps.goals && ps.goals.length > 0) {
		result += "**Goals**\n";
		result += formatContextualGoalArray(ps.goals);
	}
	if (ps["smt-goals"] && ps["smt-goals"].length > 0) {		
		result += "**SMT Goals**\n";
		result += formatContextualGoalArray(ps["smt-goals"]);
	}
	return result;
}

// Print a single symbol entry to show in a hover message
function formatIdeSymbol(symbol:  IdeSymbol) : Hover {
	return {
			contents: {
				kind:'markdown',
				value:"```fstar\n" + symbol.name + ":\n" + symbol.type + "\n```\n"
			}
	};
}

// Find the word at the given position in the given document
// (used to find the symbol under the cursor)
function findWordAtPosition(textDocument: TextDocument, position: Position) : WordAndRange {
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
	const range = Range.create(textDocument.positionAt(start), textDocument.positionAt(end));
	return {word: word, range: rangeAsFStarRange(range)};
}

// Lookup the symbol table for the symbol under the cursor
function findIdeSymbolAtPosition(textDocument: TextDocument, position: Position) {
	const uri = textDocument.uri;
	const doc_state = documentStates.get(uri);
	if (!doc_state) { return; }
	const wordAndRange = findWordAtPosition(textDocument, position);
	const range = wordAndRange.range;
	const rangeKey = JSON.stringify(range);
	const result = doc_state.hover_symbol_info.get(rangeKey);
	return { symbolInfo: result, wordAndRange: wordAndRange };
}

// Lookup the proof state table for the line at the cursor
function findIdeProofStateAtLine(textDocument: TextDocument, position: Position) {
	const uri = textDocument.uri;
	const doc_state = documentStates.get(uri);
	if (!doc_state) { return; }
	const rangeKey = position.line + 1;
	return doc_state.hover_proofstate_info.get(rangeKey);
}

function clearIdeProofProofStateAtRange(textDocument: TextDocument, range: FStarRange) {
	const uri = textDocument.uri;
	const doc_state = documentStates.get(uri);
	if (!doc_state) { return; }
	const line_ctr = range.beg[0];
	const end_line_ctr = range.end[0];
	for (let i = line_ctr; i <= end_line_ctr; i++) {
		doc_state.hover_proofstate_info.delete(i);
	}
}

// Lookup any auto-complete information for the symbol under the cursor
function findIdeAutoCompleteAtPosition(textDocument: TextDocument, position: Position) {
	const uri = textDocument.uri;
	const doc_state = documentStates.get(uri);
	if (!doc_state) { return; }
	const wordAndRange = findWordAtPosition(textDocument, position);
	const auto_completions = [];
	if (wordAndRange.word.length > 3) {
		for (const [key, value] of doc_state.auto_complete_info) {
			if (wordAndRange.word.startsWith(key)) {
				auto_completions.push({key, value});
			}
		}
	}
	return {
		auto_completions,
		wordAndRange
	};
}

////////////////////////////////////////////////////////////////////////////////////
// Range utilities
////////////////////////////////////////////////////////////////////////////////////
function mkPosition(pos: number []) : Position {
	//F* line numbers begin at 1; unskew
	return Position.create(pos[0] > 0 ? pos[0] - 1 : pos[0], pos[1]);
}

function fstarRangeAsRange (rng: FStarRange) : Range {
	return Range.create(mkPosition(rng.beg), mkPosition(rng.end));
}

function rangeAsFStarRange (rng: Range) : FStarRange {
	return {
		fname: "<input>",
		beg: [rng.start.line + 1, rng.start.character],
		end: [rng.end.line + 1, rng.end.character]
	};
}

////////////////////////////////////////////////////////////////////////////////////
// Custom client/server protocol
////////////////////////////////////////////////////////////////////////////////////

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);


function sendStatusStarted (msg : StatusStartedMessage)  {
	connection.sendNotification('fstar-vscode-assistant/statusStarted', msg);
}

function sendStatusOk (msg : StatusOkMessage)  {
	connection.sendNotification('fstar-vscode-assistant/statusOk', msg);
}

function sendStatusFailed (msg : StatusFailedMessage)  {
	connection.sendNotification('fstar-vscode-assistant/statusFailed', msg);
}

function sendStatusClear (msg: StatusClearMessage) {
	connection.sendNotification('fstar-vscode-assistant/statusClear', msg);
}


 ///////////////////////////////////////////////////////////////////////////////////
 // Handling responses from the F* IDE protocol
 ///////////////////////////////////////////////////////////////////////////////////

 // Event handler for stdout on fstar_ide
 function handleFStarResponseForDocument(textDocument: TextDocument, data:string, lax:boolean) {
	console.log("<<< " + (lax? "lax" : "") + "uri:<" +textDocument.uri + ">:" +data);
	const lines = data.toString().split('\n');
	lines.forEach(line => { handleOneResponseForDocument(textDocument, line, lax);  });
}

// Main event dispatch for IDE responses
function handleOneResponseForDocument(textDocument: TextDocument, data:string, lax: boolean) {
	// console.log("handleOneResponse " + (lax? "lax" : "") + ":<" +data+ ">");
	if (data == "") { return; }
	let r : IdeResponse;
	try {
		r = JSON.parse(data);
	} 
	catch (err) {
		console.log("Error parsing response: " + err);
		return;
	}
	if (r.kind == "protocol-info") {
		return handleIdeProtocolInfo(textDocument, r as ProtocolInfo);
	}
	else if (r.kind == "message" && r.level == "progress" && !lax) {
		//Discard progress messages from fstar_lax_ide
		return handleIdeProgress(textDocument, r.contents as IdeProgress);
	}
	else if (r.kind == "message" && r.level == "proof-state") {
		if (!r.contents) { return; }
		return handleIdeProofState(textDocument, r.contents as IdeProofState);
	}
	else if (r.kind == "response" && r.status == "failure") {
		if (!r.response) { return; }
		return handleIdeDiagnostics(textDocument, r.response as IdeError[]);
	}
	else if (r.kind == "response" && r.status == "success") { 
		if (!r.response) { return; }
		switch (decideIdeReponseType(r.response)) {
			case 'symbol':
				return handleIdeSymbol(textDocument, r.response as IdeSymbol);

			case 'error':
				return handleIdeDiagnostics(textDocument, r.response as IdeError[]);

			case 'auto-complete':
				return handleIdeAutoComplete(textDocument, r.response as IdeAutoCompleteResponses);
		}
	}
	else {
		console.log("Unhandled response: " + r.kind);
	}
}

 // If the F* does not support full-buffer queries, we log it and set a flag
 function handleIdeProtocolInfo(textDocument: TextDocument, pi : ProtocolInfo) {
	if (!pi.features.includes("full-buffer")) {
		supportsFullBuffer = false;
		console.log("fstar.exe does not support full-buffer queries.");
	}
} 

// If we get a response to a symbol query, we store it in the symbol table map
function handleIdeSymbol(textDocument: TextDocument, response : IdeSymbol) {
	// console.log("Got ide symbol " +JSON.stringify(response));
	const rng = JSON.stringify(response["symbol-range"]);
	const hoverSymbolMap = documentStates.get(textDocument.uri)?.hover_symbol_info;
	if (hoverSymbolMap) {
		hoverSymbolMap.set(rng, response);
	}
}

// If we get a proof state dump message, we store it in the proof state map
function handleIdeProofState (textDocument: TextDocument, response : IdeProofState) {
	// console.log("Got ide proof state " + JSON.stringify(response));
	const range_key = response.location.beg[0];
	const hoverProofStateMap = documentStates.get(textDocument.uri)?.hover_proofstate_info;
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
function handleIdeProgress(textDocument: TextDocument, contents : IdeProgress) {
	const doc_state = documentStates.get(textDocument.uri);
	if (!doc_state) { return; }
	if (contents.stage == "full-buffer-fragment-ok" ||
		contents.stage == "full-buffer-fragment-lax-ok") {
		if (doc_state.prefix_stale) { return; }
		const rng = contents.ranges;
		if (!contents["code-fragment"]) { return; }
		const code_fragment = contents["code-fragment"];
		const currentText = textDocument.getText(fstarRangeAsRange(code_fragment.range));
		const okText = code_fragment.code;
		if (currentText.trim() != okText.trim()) { 
			// console.log("!!!!!!!!!!!!!!!!!!!!!Expected text: <\n" + okText + "\n> but got: <\n" + currentText + "\n>");
			doc_state.prefix_stale = true;
			return;
		}
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			lax: contents.stage == "full-buffer-fragment-lax-ok",
			ranges: [ok_range]
		};
		sendStatusOk(msg);	
		return;
	}
	if (contents.stage == "full-buffer-fragment-started") {
		const rng = contents.ranges;
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			ranges: [ok_range]
		};
		sendStatusStarted(msg);
		//If there's any proof state for the range that's starting
		//clear it, because we'll get updates from fstar_ide
		clearIdeProofProofStateAtRange(textDocument, rng);
		return;
	}
	if (contents.stage == "full-buffer-fragment-failed") {
		const rng = contents.ranges;
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			ranges: [ok_range]
		};
		sendStatusFailed(msg);
		return;
	}
}

// If we get errors and warnings from F*, we send them to VSCode
// as diagnostics, which will show them as squiggles in the editor
function handleIdeDiagnostics (textDocument : TextDocument, response : IdeError []) {
	function ideErrorLevelAsDiagnosticSeverity (level: string) : DiagnosticSeverity {
		switch (level) {
			case "warning": return DiagnosticSeverity.Warning;
			case "error": return DiagnosticSeverity.Error;
			case "info": return DiagnosticSeverity.Information;
			default: return DiagnosticSeverity.Error;
		}
	}
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

function handleIdeAutoComplete(textDocument : TextDocument, response : IdeAutoCompleteResponses) {
	if (!response || !(Array.isArray(response))) { return; }
	const doc_state = documentStates.get(textDocument.uri);
	if (!doc_state) { return; }
	let searchTerm = undefined;
	response.forEach((resp) => {
		const annot = resp[1];
		if (annot == "<search term>") {
			searchTerm = resp[2];
		}
	});
	if (!searchTerm) { return; }
	doc_state.auto_complete_info.set(searchTerm, response);
	return;
}

////////////////////////////////////////////////////////////////////////////////////
// Main event handlers for events triggered by the editor client
////////////////////////////////////////////////////////////////////////////////////
// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;
let supportsFullBuffer = true;

// Initialization of the LSP server: Called once when the workspace is opened
// Advertize the capabilities of the server
//   - incremental text documentation sync
//   - completion
//   - hover
//   - definitions
//   - workspaces
//   - reformatting
connection.onInitialize((params: InitializeParams) => {
	function initializeWorkspaceFolder(folder: WorkspaceFolder) {
		const folderPath = URI.parse(folder.uri).fsPath;
		const configFiles = findFilesByExtension(folderPath, ".fst.config.json");
		if (configFiles.length == 0) {
			return;
		}
		if (configFiles.length > 1) {
			console.log("Warning: multiple .fst.config.json files found in " + folderPath);
		}
		const configFile = configFiles[0];
		// console.log("Found config file " + configFile);
		const contents = fs.readFileSync(configFile, 'utf8');
		const config = JSON.parse(contents);
		if (!config.cwd) {
			config.cwd = folderPath;
		}
		return {folderPath, config};
	}
	const capabilities = params.capabilities;
	if (params.workspaceFolders) {
		params.workspaceFolders?.forEach(folder => {
			const pathAndConfig = initializeWorkspaceFolder(folder);
			if (pathAndConfig) {
				workspaceConfigs.set(pathAndConfig.folderPath, pathAndConfig.config);
			}
		});
		workspaceFolders = params.workspaceFolders;
	}

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	// This is left-over from the lsp-sample
	// We don't do anything special with configuations yet
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
			completionProvider: {
				resolveProvider: true
			},
			hoverProvider: true,
			definitionProvider: true,
			documentRangeFormattingProvider: true,
		}
	};
	// Workspace folders: We use them for .fst.config.json files
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}		
	return result;
});

// The client acknowledged the initialization
connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			// We don't do anything special when workspace folders change
			// We should probably reset the workspace configs and re-read the .fst.config.json files
			connection.console.log('Workspace folder change event received.');
		});
	}
});

// We don't do anything special when the configuration changes
connection.onDidChangeConfiguration(change => {
	return;
});

function refreshDocumentState(textDocument : TextDocument) {
	// Find its config file
	const fstarConfig = findConfigFile(textDocument);

	// Construct the options for fstar.exe
	const filePath = URI.parse(textDocument.uri);
	const filename = path.basename(filePath.fsPath);
	const options = ["--ide", filename];
	fstarConfig.options.forEach((opt) => { options.push(opt); });
	fstarConfig.include_dirs.forEach((dir) => { options.push("--include"); options.push(dir); });

	console.log("Spawning fstar with options: " +options);
	const fstar_ide =
		cp.spawn(
			fstarConfig.fstar_exe,
			options,
			{cwd:fstarConfig.cwd});

	// Same options for the lax process, just add --lax
	options.push("--lax");
	const fstar_lax_ide =
		cp.spawn(
			fstarConfig.fstar_exe,
			options,
			{cwd:fstarConfig.cwd});

	// Initialize the document state for this doc
	documentStates.set(textDocument.uri, { 
						fstar_ide: fstar_ide,
						fstar_lax_ide: fstar_lax_ide,
						last_query_id: 0,
						hover_symbol_info: new Map(),
						hover_proofstate_info: new Map(),
						auto_complete_info: new Map(),
						prefix_stale: false
					});

	// Set the event handlers for the fstar processes
	fstar_ide.stdin.setDefaultEncoding('utf-8');
	fstar_ide.stdout.on('data', (data) => { handleFStarResponseForDocument(textDocument, data, false); });
	fstar_ide.stderr.on('data', (data) => { console.log("fstar stderr: " +data); });
	fstar_lax_ide.stdin.setDefaultEncoding('utf-8');
	fstar_lax_ide.stdout.on('data', (data) => { handleFStarResponseForDocument(textDocument, data, true); });
	fstar_lax_ide.stderr.on('data', (data) => { console.log("fstar lax stderr: " +data); });
	
	// Send the initial dummy vfs-add request to the fstar processes
	const vfs_add : VfsAdd = {"query":"vfs-add","args":{"filename":null,"contents":textDocument.getText()}};
	sendRequestForDocument(textDocument, vfs_add);
	sendRequestForDocument(textDocument, vfs_add, 'lax');
}

// The main entry point when a document is opened
//  * find the .fst.config.json file for the document in the workspace, otherwise use a default config
//  * spawn 2 fstar processes: one for typechecking, one lax process for fly-checking and symbol lookup
//  * set event handlers to read the output of the fstar processes
//  * send the current document to both processes to start typechecking
documents.onDidOpen( e => {
	// The document in the current editor
	const textDocument = e.document;

	refreshDocumentState(textDocument);

	// And ask the main fstar process to verify it
	validateFStarDocument(textDocument, "full");

	// The lax fstar will run in the background and will send us diagnostics as it goes	
});

function killFStarProcessesForDocument(textDocument : TextDocument) {
	const docState = documentStates.get(textDocument.uri);
	if (!docState) return;
	docState.fstar_ide.kill();
	docState.fstar_lax_ide.kill();
	documentStates.delete(textDocument.uri);
}

// Only keep settings for open documents
documents.onDidClose(e => {
	killFStarProcessesForDocument(e.document);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateFStarDocument(change.document, "full", 'lax');
	validateFStarDocument(change.document, "cache");
});

documents.onDidSave(change => {
	validateFStarDocument(change.document, "full");
});

connection.onDidChangeWatchedFiles(_change => {
	// Monitored files have change in VSCode
	// connection.console.log('We received an file change event');
});

// The document state holds a table of completions for words in the document
// This table is populated lazily by autocomplete calls to fstar_lax_ide 
// We look in the table for a best match for the current word at the cursor
// If we find a match, we return it
// If the best match is not a perfect match (i.e., it doesn't match the word
// at the cursor exactly), we send we send a request to fstar_lax_ide
// for the current word, for use at subsequent completion calls
connection.onCompletion(
	(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		const doc = documents.get(textDocumentPosition.textDocument.uri);
		if (!doc) { return []; }
		// move the cursor back one character to get the word before the cursor
		const position = Position.create(
				textDocumentPosition.position.line,
				textDocumentPosition.position.character - 1);
		const autoCompleteResponses = findIdeAutoCompleteAtPosition(doc, position);
		if (!autoCompleteResponses) {
			return [];
		}
		let shouldSendRequest = false;
		let bestMatch : {key:string; value:IdeAutoCompleteResponses} = { key: "", value: [] };
		autoCompleteResponses.auto_completions.forEach((response) => {
			if (response.key.length > bestMatch.key.length) {
				bestMatch = response;
			}
		});
		shouldSendRequest = bestMatch.key != autoCompleteResponses.wordAndRange.word;
		if (shouldSendRequest) {
			const wordAndRange = autoCompleteResponses.wordAndRange;
			// Don't send requests for very short words
			if (wordAndRange.word.length < 3) return [];
			const autoCompletionRequest : AutocompleteRequest = {
				"query": "autocomplete",
				"args": {
					"partial-symbol": wordAndRange.word,
					"context": "code"
				}
			};
			sendRequestForDocument(doc, autoCompletionRequest);
		}
		const items : CompletionItem[] = [];
		bestMatch.value.forEach((response) => {
			const data = response;
			// vscode replaces the word at the cursor with the completion item
			// but its notion of word is the suffix of the identifier after the last dot
			// so the completion we provide is the suffix of the identifier after the last dot
			const label = response[2].lastIndexOf('.') > 0 ? response[2].substring(response[2].lastIndexOf('.') + 1) : response[2];
			const item : CompletionItem = {
				label: label,
				kind: CompletionItemKind.Text,
				data: data
			};
			items.push(item);
		});
		return items;
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve(
	(item: CompletionItem): CompletionItem => {
		return item;
	}
);

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
connection.onHover(
	(textDocumentPosition: TextDocumentPositionParams): Hover => {
		const textDoc = documents.get(textDocumentPosition.textDocument.uri);
		if (!textDoc) { return {contents: ""}; }
		// First, check if we have proof state information for this line
		const proofState = findIdeProofStateAtLine(textDoc, textDocumentPosition.position);
		if (proofState) {
			return {
				contents: {
					kind:'markdown',
					value:formatIdeProofState(proofState)
				}
			};
		}
		// Otherwise, check if we have symbol information for this symbol
		const symbol = findIdeSymbolAtPosition(textDoc, textDocumentPosition.position);
		if (!symbol) { return {contents: "No symbol info"}; }	
		if (symbol && symbol.symbolInfo) { 
			return formatIdeSymbol(symbol.symbolInfo);
		}
		requestSymbolInfo(textDoc, textDocumentPosition.position, symbol.wordAndRange);
		return {contents: {kind:'plaintext', value:"Looking up:" + symbol.wordAndRange.word}};
	}
);


// The onDefinition handler is called when the user clicks on a symbol
// It's very similar to the onHover handler, except that it returns a
// LocationLink object instead of a Hover object
connection.onDefinition((defParams : DefinitionParams) => {
	const textDoc = documents.get(defParams.textDocument.uri);
	if (!textDoc) { return []; }
	const symbol = findIdeSymbolAtPosition(textDoc, defParams.position);
	if (!symbol) { return []; }
	if (symbol && symbol.symbolInfo) {
		const sym = symbol.symbolInfo;
		const defined_at = sym["defined-at"];
		if (!defined_at) { return []; }		
		const range = fstarRangeAsRange(defined_at);
		const uri = defined_at.fname == "<input>" ? textDoc.uri : pathToFileURL(defined_at.fname).toString();
		const location = LocationLink.create(uri, range, range);
		return [location];
	}
	requestSymbolInfo(textDoc, defParams.position, symbol.wordAndRange);
	return [];
 });

connection.onDocumentRangeFormatting((formatParams : DocumentRangeFormattingParams) => {
	const textDoc = documents.get(formatParams.textDocument.uri);
	if (!textDoc) { return []; }
	const text = textDoc.getText(formatParams.range);
	// call fstar.exe synchronously to format the text
	const fstarConfig = findConfigFile(textDoc);
	const format_query = {
		"query-id" : "1",
		query : "format",
		args : {
			code: text
		}
	};
	const fstarFormatter =
		cp.spawnSync(fstarConfig.fstar_exe, 
						["--ide", "prims.fst"], 
						{input: JSON.stringify(format_query)});
	const data = fstarFormatter.stdout.toString();
	// console.log("Formatter stdout: " + data);
	// data.trim().split("\n").forEach(line => { console.log("Formatter stdout: " + line); });
	// return [];
	const replies = data.trim().split('\n').map(line => {  return JSON.parse(line); });
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
});

connection.onRequest("fstar-vscode-assistant/verify-to-position", (params : any) => {
	const uri = params[0];
	const position : { line: number, character: number } = params[1];
	// console.log("Received verify request with parameters: " + uri + " " + JSON.stringify(position));
	const textDocument = documents.get(uri);
	if (!textDocument) { return; }
	validateFStarDocumentToPosition(textDocument, "verify-to-position", {line:position.line + 1, column:position.character});
});

connection.onRequest("fstar-vscode-assistant/lax-to-position", (params : any) => {
	const uri = params[0];
	const position : { line: number, character: number } = params[1];
	// console.log("Received lax-to-position request with parameters: " + uri + " " + JSON.stringify(position));
	const textDocument = documents.get(uri);
	if (!textDocument) { return; }
	validateFStarDocumentToPosition(textDocument, "lax-to-position", {line:position.line + 1, column:position.character});
});

connection.onRequest("fstar-vscode-assistant/restart", (uri : any) => {
	// console.log("Received restart request with parameters: " + uri);
	const textDocument = documents.get(uri);
	if (!textDocument) { return; }
	killFStarProcessesForDocument(textDocument);
	refreshDocumentState(textDocument);
	connection.sendDiagnostics({uri:textDocument.uri, diagnostics:[]});
	sendStatusClear({uri:textDocument.uri});
});

connection.onRequest("fstar-vscode-assistant/text-doc-changed", (params : any) => {
	const uri = params[0];
	const range : { line:number ; character:number} [] = params[1];
	const textDocument = documents.get(uri);
	if (!textDocument) { return; }
	const cancelRequest : CancelRequest = { 
		query:"cancel",
		args: { 
			"cancel-line" : range[0].line + 1,
			"cancel-column" : range[0].character
		}
	};
	sendRequestForDocument(textDocument, cancelRequest);
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();