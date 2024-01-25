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
	// We assume that the server is well-behaved and doesn't send ill-formed
	// messages
	return object
		&& object.kind && object.kind === 'protocol-info';
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

// A Contextual goal is a goal with all the hypothesis in context
export interface IdeProofStateContextualGoal {
	hyps: {
		name: string;
		type: string;
	}[];
	goal: IdeProofStateGoal;
}

// A goal itself is a witness and a type, with a label
export interface IdeProofStateGoal {
	witness: string;
	type: string;
	label: string;
}

// IDEError: fstar.exe sends this message when reporting errors and warnings
export interface IdeError {
	message: string;
	number: number;
	level: 'warning' | 'error' | 'info';
	ranges: FStarRange[];
}

export interface IdeCodeFragment {
	"code-digest": string;
	range: FStarRange;
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


// An auto-complete response
export type IdeAutoCompleteResponse = [number, string, string];
export type IdeAutoCompleteResponses = IdeAutoCompleteResponse[];
export type IdeQueryResponseTypes = IdeSymbol | IdeError | IdeError[] | IdeAutoCompleteResponses;

// A query response envelope
export interface IdeQueryResponse {
	'query-id': string;
	kind: 'protocol-info' | 'response' | 'message';
	status?: 'success' | 'failure';
	level?: 'progress' | 'proof-state' | 'info';
	response?: IdeQueryResponseTypes;
	contents?: IdeProofState | IdeSymbol | IdeProgress;
}

export type IdeResponse = IdeQueryResponse | ProtocolInfo

// An extension to the `IdeError[]` type that includes a `kind` field to easily
// identify when an error response is received instead of the expected type,
// such as `IdeProgress`.
export interface IdeErrors {
	kind: 'errors';
	contents: IdeError[];
}

export function isIdeErrors(object: any): boolean {
	return object
		&& object.kind && object.kind === 'errors';
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

// A Cancel message is sent to fstar_ide when the document changes at a given range, to stop it
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
