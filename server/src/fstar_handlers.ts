import {
	Diagnostic,
	DiagnosticRelatedInformation,
	DiagnosticSeverity,
	Range
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import * as crypto from 'crypto';

import { Server } from './server';
import { StatusOkMessage, ok_kind } from './client_connection';
import { mkPosition, fstarRangeAsRange, qualifyFilename } from './utils';
import { FStarRange, IdeAutoCompleteResponses, IdeError, IdeProgress, IdeProofState, IdeSymbol, ProtocolInfo } from './fstar_messages';
import { FStarConnection } from './fstar_connection';


///////////////////////////////////////////////////////////////////////////////////
// Handling responses from the F* IDE protocol
///////////////////////////////////////////////////////////////////////////////////

// We use the higher-level message handler exposed by `FStarConnection` for the
// stdout streams. This handler takes care of buffering messages and will invoke
// the handler once for each received valid F* message.
//
// The server parameter is passed freshly with every request to avoid potential
// rebinding errors in the future. Furthermore, server is passed instead of
// configurationSettings (which is also stored on the server instance) to avoid
// accidentally closing over stale configurationSettings arguments when this
// function is called (since they can be rebound within the server).
export function registerFStarHandlers(fstar_conn: FStarConnection, textDocument: TextDocument, lax: boolean, server: Server) {
	const stdout_stream = 'stdout';
	if (server.configurationSettings.debug) {
		fstar_conn.on(stdout_stream, 'message', (message) => {
			console.log("<<< " + (lax ? "lax" : "") + "uri:<" + textDocument.uri + ">:" + message);
		});
	}

	fstar_conn.on(stdout_stream, 'message:protocol-info', r => handleIdeProtocolInfo(textDocument, r, server));
	fstar_conn.on(stdout_stream, 'message:ide-progress', r => handleIdeProgress(textDocument, r, lax, server));
	fstar_conn.on(stdout_stream, 'message:ide-proof-state', r => handleIdeProofState(textDocument, r, server));
	fstar_conn.on(stdout_stream, 'message:ide-symbol', r => handleIdeSymbol(textDocument, r, server));
	fstar_conn.on(stdout_stream, 'message:ide-error', r => handleIdeDiagnostics(textDocument, r, lax, server));
	fstar_conn.on(stdout_stream, 'message:ide-auto-complete', r => handleIdeAutoComplete(textDocument, r, server));

	fstar_conn.on(stdout_stream, 'message:ide-info', r => console.log("Info: " + r));

	// The stderr handlers just log every bit of received data
	const proc_name = lax ? "fstar lax" : "fstar";
	fstar_conn.on('stderr','data', (data) => { console.error(proc_name + " stderr: " + data); });
}

// If the F* does not support full-buffer queries, we log it and set a flag
function handleIdeProtocolInfo(textDocument: TextDocument, pi: ProtocolInfo, server: Server) {
	if (!pi.features.includes("full-buffer")) {
		// Both fstar and fstar_lax have their own supportsFullBuffer flag, we
		// set both of them here assuming that they both have the same support
		// for full-buffer queries.
		const fstar_conn = server.getFStarConnection(textDocument);
		const fstar_lax_conn = server.getFStarConnection(textDocument, 'lax');
		if (fstar_conn) { fstar_conn.fstar.supportsFullBuffer = false; }
		if (fstar_lax_conn) { fstar_lax_conn.fstar.supportsFullBuffer = false; }
		console.error("fstar.exe does not support full-buffer queries.");
	}
}

// If we get a response to a symbol query, we store it in the symbol table map
function handleIdeSymbol(textDocument: TextDocument, response: IdeSymbol, server: Server) {
	// console.log("Got ide symbol " +JSON.stringify(response));
	const rng = JSON.stringify(response["symbol-range"]);
	const hoverSymbolMap = server.getDocumentState(textDocument.uri)?.hover_symbol_info;
	if (hoverSymbolMap) {
		hoverSymbolMap.set(rng, response);
	}
}

// If we get a proof state dump message, we store it in the proof state map
function handleIdeProofState(textDocument: TextDocument, response: IdeProofState, server: Server) {
	// console.log("Got ide proof state " + JSON.stringify(response));
	const range_key = response.location.beg[0];
	const hoverProofStateMap = server.getDocumentState(textDocument.uri)?.hover_proofstate_info;
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
function handleIdeProgress(textDocument: TextDocument, contents: IdeProgress, lax: boolean, server: Server) {
	const doc_state = server.getDocumentState(textDocument.uri);
	if (!doc_state) { return; }
	if (contents.stage == "full-buffer-started") {
		if (lax) {
			doc_state.fstar_lax_diagnostics = [];
		}
		else {
			doc_state.fstar_diagnostics = [];
		}
		return;
	}
	if (contents.stage == "full-buffer-finished") {
		if (lax) {
			server.connection.sendDiagnostics({
				uri: textDocument.uri,
				lax: true,
				diagnostics: doc_state.fstar_lax_diagnostics
			});
		}
		else {
			server.connection.sendDiagnostics({
				uri: textDocument.uri,
				lax: false,
				diagnostics: doc_state.fstar_diagnostics
			});
		}
		return;
	}
	if (lax) { return; }
	// We don't send intermediate diagnostics and gutter icons for flycheck progress
	if (contents.stage == "full-buffer-fragment-ok" ||
		contents.stage == "full-buffer-fragment-lax-ok") {
		if (doc_state.prefix_stale) { return; }
		const rng = contents.ranges;
		if (!contents["code-fragment"]) { return; }
		const code_fragment = contents["code-fragment"];
		const currentText = textDocument.getText(fstarRangeAsRange(code_fragment.range));
		// compute an MD5 digest of currentText.trim
		const md5 = crypto.createHash('md5');
		md5.update(currentText.trim());
		const digest = md5.digest('hex');
		if (digest != code_fragment['code-digest']) {
			if (server.configurationSettings.debug) {
				console.log("Not setting gutter ok icon: Digest mismatch at range " + JSON.stringify(rng));
			}
			doc_state.prefix_stale = true;
			return;
		}
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		let ok_kind: ok_kind;
		if (contents.stage == "full-buffer-fragment-lax-ok") { ok_kind = "light-checked"; }
		else { ok_kind = "checked"; }
		const msg: StatusOkMessage = {
			uri: textDocument.uri,
			ok_kind: ok_kind,
			ranges: [ok_range]
		};
		server.connection.sendStatusOk(msg);
		return;
	}
	if (contents.stage == "full-buffer-fragment-started") {
		const rng = contents.ranges;
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			ranges: [ok_range]
		};
		server.connection.sendStatusInProgress(msg);
		//If there's any proof state for the range that's starting
		//clear it, because we'll get updates from fstar_ide
		server.clearIdeProofProofStateAtRange(textDocument, rng);
		return;
	}
	if (contents.stage == "full-buffer-fragment-failed") {
		const rng = contents.ranges;
		const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
		const msg = {
			uri: textDocument.uri,
			ranges: [ok_range]
		};
		server.connection.sendStatusFailed(msg);
		return;
	}
}

// If we get errors and warnings from F*, we send them to VSCode
// as diagnostics, which will show them as squiggles in the editor
function handleIdeDiagnostics(textDocument: TextDocument, response: IdeError[], lax: boolean, server: Server) {
	function ideErrorLevelAsDiagnosticSeverity(level: string): DiagnosticSeverity {
		switch (level) {
			case "warning": return DiagnosticSeverity.Warning;
			case "error": return DiagnosticSeverity.Error;
			case "info": return DiagnosticSeverity.Information;
			default: return DiagnosticSeverity.Error;
		}
	}
	if (!response || !(Array.isArray(response))) {
		server.connection.sendAlert({ message: "Got invalid response to ide diagnostics request: " + JSON.stringify(response), uri: textDocument.uri });
		return;
	}
	const diagnostics: Diagnostic[] = [];
	response.forEach((err) => {
		let diag: Diagnostic | undefined = undefined;
		let shouldAlertErrorInDifferentFile = false;
		err.ranges.forEach((rng) => {
			if (!diag) {
				// First range for this error, construct the diagnostic message.
				let mainRange;
				const relatedInfo = [];
				if (rng.fname != "<input>") {
					// This is a diagnostic raised on another file
					shouldAlertErrorInDifferentFile = err.level == "error";
					const defaultRange: FStarRange = {
						fname: "<input>",
						beg: [1, 0],
						end: [1, 0]
					};
					mainRange = defaultRange;
					const relationLocation = {
						uri: qualifyFilename(rng.fname, textDocument.uri, server),
						range: fstarRangeAsRange(rng)
					};
					const ri: DiagnosticRelatedInformation = {
						location: relationLocation,
						message: "related location"
					};
					relatedInfo.push(ri);
				}
				else {
					mainRange = rng;
				}
				diag = {
					severity: ideErrorLevelAsDiagnosticSeverity(err.level),
					range: fstarRangeAsRange(mainRange),
					message: err.message,
					relatedInformation: relatedInfo
				};
			} else if (diag) {
				const relatedLocation = {
					uri: qualifyFilename(rng.fname, textDocument.uri, server),
					range: fstarRangeAsRange(rng)
				};
				const relatedInfo: DiagnosticRelatedInformation = {
					location: relatedLocation,
					message: "related location"
				};
				if (diag.relatedInformation) {
					diag.relatedInformation.push(relatedInfo);
				}
			}
		});
		if (shouldAlertErrorInDifferentFile) {
			server.connection.sendAlert({ message: err.message, uri: textDocument.uri });
		}
		if (diag) {
			diagnostics.push(diag);
		}
	});
	const docState = server.getDocumentState(textDocument.uri);
	if (!docState) { return; }
	if (lax) {
		docState.fstar_lax_diagnostics = docState.fstar_lax_diagnostics.concat(diagnostics);
	}
	else {
		docState.fstar_diagnostics = docState.fstar_diagnostics.concat(diagnostics);
	}
}

function handleIdeAutoComplete(textDocument: TextDocument, response: IdeAutoCompleteResponses, server: Server) {
	if (!response || !(Array.isArray(response))) { return; }
	const doc_state = server.getDocumentState(textDocument.uri);
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
