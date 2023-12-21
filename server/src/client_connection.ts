import {
	createConnection,
	Diagnostic,
	ProposedFeatures,
	Range,
	_Connection
} from 'vscode-languageserver/node';

////////////////////////////////////////////////////////////////////////////////////
// Custom client/server protocol
////////////////////////////////////////////////////////////////////////////////////
/**
 * A `ClientConnection` is a connection between the LSP server and client (e.g. the
 * vscode extension).
 */
export class ClientConnection {
	conn: _Connection;

	constructor() {
		// Create a connection for the server, using Node's IPC as a transport.
		// Also include all preview / proposed LSP features.
		this.conn = createConnection(ProposedFeatures.all);
	}

	sendStatusStarted(msg: StatusStartedMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/statusStarted', msg);
	}

	sendStatusInProgress(msg: StatusInProgressMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/statusInProgress', msg);
	}

	sendStatusOk(msg: StatusOkMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/statusOk', msg);
	}

	sendStatusFailed(msg: StatusFailedMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/statusFailed', msg);
	}

	sendStatusClear(msg: StatusClearMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/statusClear', msg);
	}

	sendAlert(msg: AlertMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/alert', msg);
	}

	sendDiagnostics(msg: DiagnosticsMessage) {
		this.conn.sendNotification('fstar-vscode-assistant/diagnostics', msg);
	}

	sendClearDiagnostics(msg: ClearDiagnosticsMessage) {

		this.conn.sendNotification('fstar-vscode-assistant/clearDiagnostics', msg);
	}
}


////////////////////////////////////////////////////////////////////////////////////
// Messages in a small custom protocol between this server and the client
// (running on top of LSP)
////////////////////////////////////////////////////////////////////////////////////

// TODO(klinvill): These message interfaces should be refactored out of the client and server components into a shared library so they both use the same definitions.

// A message to clear all gutter icons for the document with the given URI
export interface StatusClearMessage {
	uri: string;
}

// A message to set the chevron icons for the prefix of the buffer that has been started
export interface StatusStartedMessage {
	uri: string;
	ranges: Range[]; // A VSCode range, not an FStarRange
}

// A message to set hourglass icons for the current chunk being verified
export interface StatusInProgressMessage {
	uri: string;
	ranges: Range[]; // A VSCode range, not an FStarRange
}

// A message to dislay various line gutter icons for the document of the given URI
// at the given ranges
export type ok_kind = 'checked' | 'light-checked';
export interface StatusOkMessage {
	uri: string;
	ok_kind: ok_kind;
	ranges: Range[]; // A VSCode range, not an FStarRange
}

// A message to clear hourglass gutter icons for the document of the given URI
// at the given ranges
export interface StatusFailedMessage {
	uri: string;
	ranges: Range[]; // A VSCode range, not an FStarRange
}

// An alert message for a document, sent if the the F* process crashed
export interface AlertMessage {
	uri: string;
	message: string;
}

export interface DiagnosticsMessage {
	uri: string;
	lax: boolean;
	diagnostics: Diagnostic[];
}

export interface ClearDiagnosticsMessage {
	uri: string;
}
