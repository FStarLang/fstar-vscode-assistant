import { Ok, Result } from './result';


////////////////////////////////////////////////////////////////////////////////////
// Response messages in the IDE protocol that fstar.exe uses
////////////////////////////////////////////////////////////////////////////////////

// ProtocolInfo: The first response from fstar.exe when it is first launched
export interface ProtocolInfo {
	kind: 'protocol-info';
	version: number;
	features: string[];
}

export function isProtocolInfo(object: any): boolean {
	return object
		&& object.kind && object.kind === 'protocol-info'
		&& object.version
		&& object.features;
}

export function parseProtocolInfo(object: any): ProtocolInfo | undefined {
	if (isProtocolInfo(object)) return object;
}

// An FStarRange is a range of positions in some source file
// A position is a line number and a column number
// A quirk is that the line number is 1-based, but the column number is 0-based
// In contrast, the LSP protocol uses 0-based line and column numbers
// So, we need to convert between the two
export interface FStarRange {
	fname: string;
	beg: number[];
	end: number[]
}

export function isFStarRange(object: any): boolean {
	return object
		&& object.fname
		&& object.beg
		&& object.end;
}

export function parseFStarRange(object: any): FStarRange | undefined {
	if (isFStarRange(object)) return object;
}

// IdeSymbol: This message is sent from fstar.exe in response to a
// request for a onHover or onDefnition symbol lookup
export interface IdeSymbol {
	kind: 'symbol';
	name: string;
	type: string;
	documentation: string;
	definition: string;
	"defined-at": FStarRange;
	"symbol-range": FStarRange;
	symbol: string;
}

export function isIdeSymbol(object: any): boolean {
	return object
		&& object.kind && object.kind === 'symbol'
		&& object.name
		&& object.type
		&& object.documentation
		&& object.definition
		&& object["defined-at"] && isFStarRange(object["defined-at"])
		&& object["symbol-range"] && isFStarRange(object["symbol-range"])
		&& object.symbol;
}

export function parseIdeSymbol(object: any): IdeSymbol | undefined {
	if (isIdeSymbol(object)) return object;
}

// IdeProofState: fstar.exe sends informative messages when running tactics
// The server does not explicitly request the proof state---these messages
// are just sent by fstar.exe as a side-effect of running tactics
// The server stores the proof state in a table, and uses it to display
// the proof state in the onHover message
export interface IdeProofState {
	label: string; // User-provided label, e.g., dump "A"
	depth: number; // The depth of this dump message (not displayed)
	urgency: number; // Urgency (not displayed)
	goals: IdeProofStateContextualGoal[]; // The main proof state
	"smt-goals": IdeProofStateContextualGoal[]; // SMT goals
	location: FStarRange; // The location of the tactic that triggered a proof state dump
}

export function isIdeProofState(object: any): boolean {
	return object
		&& object.label
		&& object.depth
		&& object.urgency
		// TODO(klinvill): How rigorous should these checks be? There's a
		// tradeoff between extra safety and speed/complexity. I'm omitting deep
		// inspection for now.
		&& object.goals
		&& object["smt-goals"]
		&& object.location && isFStarRange(object.location);
}

export function parseIdeProofState(object: any): IdeProofState | undefined {
	if (isIdeProofState(object)) return object;
}

// A Contextual goal is a goal with all the hypothesis in context
export interface IdeProofStateContextualGoal {
	hyps: {
		name: string;
		type: string;
	}[];
	goal: IdeProofStateGoal;
}

export function isIdeProofStateContextualGoal(object: any): boolean {
	return object
		&& object.hyps
		&& object.goal && isIdeProofStateGoal(object.goal);
}

export function parseIdeProofStateContextualGoal(object: any): IdeProofStateContextualGoal | undefined {
	if (isIdeProofStateContextualGoal(object)) return object;
}

// A goal itself is a witness and a type, with a label
export interface IdeProofStateGoal {
	witness: string;
	type: string;
	label: string;
}

export function isIdeProofStateGoal(object: any): boolean {
	return object
		&& object.witness
		&& object.type
		&& object.label;
}

export function parseIdeProofStateGoal(object: any): IdeProofStateGoal | undefined {
	if (isIdeProofStateGoal(object)) return object;
}

// IDEError: fstar.exe sends this message when reporting errors and warnings
export interface IdeError {
	message: string;
	number: number;
	level: 'warning' | 'error' | 'info';
	ranges: FStarRange[];
}

export function isIdeError(object: any): boolean {
	return object
		&& object.message
		&& object.number
		&& object.level
		&& object.ranges;
}

export function parseIdeError(object: any): IdeError | undefined {
	if (isIdeError(object)) return object;
}

export interface IdeCodeFragment {
	"code-digest": string;
	range: FStarRange;
}

export function isIdeCodeFragment(object: any): boolean {
	return object
		&& object["code-digest"]
		&& object.range && isFStarRange(object.range);
}

export function parseIdeCodeFragment(object: any): IdeCodeFragment | undefined {
	if (isIdeCodeFragment(object)) return object;
}

export interface IdeProgress {
	stage: 'full-buffer-started'
	| 'full-buffer-fragment-started'
	| 'full-buffer-fragment-ok'
	| 'full-buffer-fragment-lax-ok'
	| 'full-buffer-fragment-failed'
	| 'full-buffer-finished';
	ranges: FStarRange;
	"code-fragment"?: IdeCodeFragment
}

export function isIdeProgress(object: any): boolean {
	return object
		&& object.stage
		&& object.ranges && isFStarRange(object.ranges);
}

export function parseIdeProgress(object: any): IdeProgress | undefined {
	if (isIdeProgress(object)) return object;
}

// An auto-complete response
export type IdeAutoCompleteResponse = [number, string, string];
export type IdeAutoCompleteResponses = IdeAutoCompleteResponse[];
export type IdeQueryResponseTypes = IdeSymbol | IdeError | IdeError[] | IdeAutoCompleteResponses;

export function isIdeAutoCompleteResponse(object: any): boolean {
	return object && object instanceof Array && object.length == 3;
}

export function parseIdeAutoCompleteResponse(object: any): IdeAutoCompleteResponse | undefined {
	if (isIdeAutoCompleteResponse(object)) return object;
}

export function isIdeQueryResponseTypes(object: any): boolean {
	return object && (
		isIdeSymbol(object)
		|| isIdeError(object)
		|| object instanceof Array && (
			// IdeError array
			object.length == 0 || isIdeError(object[0])
			// IdeAutoCompleteResponse array
			|| isIdeAutoCompleteResponse(object[0])
		)
	);
}

export function parseIdeQueryResponseTypes(object: any): IdeQueryResponseTypes | undefined {
	if (isIdeQueryResponseTypes(object)) return object;
}

// A query response envelope
export interface IdeQueryResponse {
	'query-id': string;
	kind: 'protocol-info' | 'response' | 'message';
	status?: 'success' | 'failure';
	level?: 'progress' | 'proof-state' | 'info';
	response?: IdeQueryResponseTypes;
	contents?: IdeProofState | IdeSymbol | IdeProgress;
}

export function isIdeQueryResponse(object: any): boolean {
	return object
		&& object['query-id']
		&& object.kind;
}

export function parseIdeQueryResponse(object: any): IdeQueryResponse | undefined {
	if (isIdeQueryResponse(object)) return object;
}

export type IdeResponse = IdeQueryResponse | ProtocolInfo

export function isIdeResponse(object: any): boolean {
	return isIdeQueryResponse(object) || isProtocolInfo(object);
}

export function parseIdeResponse(message: string): Result<IdeResponse, Error> {
	try {
		const r = JSON.parse(message);

		if (isIdeResponse(r)) return new Ok(r);
		else return new Error("Response does not match any known IdeResponse type: " + message);
	}
	catch (err) {
		if (err instanceof Error)
			return err;
		else
			return new Error("Error parsing response: " + err);
	}
}

////////////////////////////////////////////////////////////////////////////////////
// Request messages in the IDE protocol that fstar.exe uses
////////////////////////////////////////////////////////////////////////////////////

// The first request from LSP to fstar.exe is a vfs-add, just to record that a file
// has been opened. The filename is usually null. It's not clear that this message
// is actually required, however, fstar-mode.el sends it, so we do too.
export interface VfsAdd {
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
export interface FullBufferQuery {
	query: 'full-buffer';
	args: {
		kind: 'full' | 'lax' | 'cache' | 'reload-deps' | 'verify-to-position' | 'lax-to-position';
		"with-symbols": boolean;
		code: string;
		line: number;
		column: number
		"to-position"?: {
			line: number;
			column: number
		}
	}
}

// A LookupQuery is sent to fstar_lax_ide to get symbol information for onHover and onDefinition
export interface LookupQuery {
	query: 'lookup';
	args: {
		context: 'code';
		symbol: string;
		"requested-info": ('type' | 'documentation' | 'defined-at')[];
		// The exact position at which the user hovered
		location: {
			filename: string;
			line: number;
			column: number;
		},
		// The range of the word at which the user hovered
		// fstar.exe echoes this back when it responds
		// and we use this to lookup the symbol table when
		// the user hovers or requests the definition of that word
		"symbol-range": FStarRange
	}
}

// A Cancel message is sent to fstar_ide when to document changes at a given range, to stop it
// from verifying the part of the buffer that has changed
export interface CancelRequest {
	query: 'cancel';
	args: {
		"cancel-line": number;
		"cancel-column": number
	}
}

// A request for autocompletion
export interface AutocompleteRequest {
	query: 'autocomplete';
	args: {
		"partial-symbol": string;
		context: 'code'
	}
}
