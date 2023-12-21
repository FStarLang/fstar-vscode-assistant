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

import { fstarVSCodeAssistantSettings } from './settings';
import { Server } from './server';
import { ClientConnection, StatusOkMessage, ok_kind } from './client_connection';
import { mkPosition, fstarRangeAsRange, qualifyFilename } from './utils';
import { FStar } from './fstar';

///////////////////////////////////////////////////////////////////////////////////
// Handling responses from the F* IDE protocol
///////////////////////////////////////////////////////////////////////////////////

// All messages from F* are expected to be valid JSON objects.
//
// TODO(klinvill): this should likely be refactored into `fstar_messages.ts` and
// should check the structure of a message, not just that it's valid JSON. A
// better method could return either the appropriate message object, or an error
// otherwise, so that the parsing could be moved out of these handlers and into
// the same file as the message definitions.
function is_valid_fstar_message(entry: string): boolean {
	try {
		JSON.parse(entry);
		return true;
	}
	catch (err) {
		return false;
	}
}

// Event handler for stdout on fstar_ide. Created as a closure to keep the
// buffer scoped only to this function. The factory function exists to make
// unit-testing easier (creating a new function is like resetting the closure
// state).
export function handleFStarResponseForDocumentFactory(configurationSettings: fstarVSCodeAssistantSettings, server: Server, connection: ClientConnection): ((textDocument: TextDocument, data: string, lax: boolean) => void) {
	// Stateful buffer to store partial messages. Messages appear to be fragmented
	// into 8192 byte chunks if they exceed this size.
	let buffer = "";

	const handleOneResponseForDocument = handleOneResponseForDocumentFactory(configurationSettings, server, connection);
	return function (textDocument: TextDocument, data: string, lax: boolean) {
		if (configurationSettings.debug) {
			console.log("<<< " + (lax ? "lax" : "") + "uri:<" + textDocument.uri + ">:" + data);
		}
		const lines = data.toString().split('\n');

		const valid_lines: string[] = [];
		for (const line of lines) {
			if (is_valid_fstar_message(line)) {
				// We assume that fragmented messages will always be delivered
				// sequentially. Because of this, receiving a non-fragmented
				// message while the buffer is non-empty results in the buffer
				// being discarded (since we assume that some error occured).
				if (buffer !== "") {
					console.error("Partially buffered message discarded: " + buffer);
				}
				buffer = "";
				valid_lines.push(line);
			} else {
				// We assume that invalid messages are just message fragments.
				// We therefore add this fragment to the buffer until the full
				// message is received.
				buffer += line;
				// The message fragment we received may be the last fragment
				// needed to complete a message. We therefore check here to see
				// if the buffer constitutes a valid message.
				if (is_valid_fstar_message(buffer)) {
					valid_lines.push(buffer);
					buffer = "";
				}
			}
		}

		valid_lines.forEach(line => { handleOneResponseForDocument(textDocument, line, lax); });
	};
}

// Factory for main event dispatch for IDE responses. The factory method exists
// to close a configurationSettings object within the returned function, thus
// preserving the semantics of the original code which used a global
// configurationSettings variable.
function handleOneResponseForDocumentFactory(configurationSettings: fstarVSCodeAssistantSettings, server: Server, connection: ClientConnection): ((textDocument: TextDocument, data: string, lax: boolean) => void) {
	const handleIdeProofState = handleIdeProofStateFactory(server);
	const handleIdeSymbol = handleIdeSymbolFactory(server);
	const handleIdeProgress = handleIdeProgressFactory(configurationSettings, server, connection);
	const handleIdeDiagnostics = handleIdeDiagnosticsFactory(server, connection);
	const handleIdeAutoComplete = handleIdeAutoCompleteFactory(server);

	return function (textDocument: TextDocument, data: string, lax: boolean) {
		if (data == "") { return; }
		let r: IdeResponse;
		try {
			r = JSON.parse(data);
		}
		catch (err) {
			console.error("Error parsing response: " + err);
			return;
		}
		if (r.kind == "protocol-info") {
			return handleIdeProtocolInfo(textDocument, r as ProtocolInfo, server);
		}
		else if (r.kind == "message" && r.level == "progress") {
			return handleIdeProgress(textDocument, r.contents as IdeProgress, lax);
		}
		else if (r.kind == "message" && r.level == "proof-state") {
			if (!r.contents) { return; }
			return handleIdeProofState(textDocument, r.contents as IdeProofState);
		}
		else if (r.kind == "response") {
			if (!r.response) {
				if (configurationSettings.debug) {
					console.log("Unexpected response: " + JSON.stringify(r));
				}
				return;
			}
			switch (decideIdeReponseType(r.response)) {
				case 'symbol':
					return handleIdeSymbol(textDocument, r.response as IdeSymbol);

				case 'error':
					return handleIdeDiagnostics(textDocument, r.response as IdeError[], lax);

				case 'auto-complete':
					return handleIdeAutoComplete(textDocument, r.response as IdeAutoCompleteResponses);
			}
		}
		else if (r.kind == "message" && r.level == "info") {
			console.log("Info: " + r.contents);
		}
		else {
			if (configurationSettings.debug) {
				console.log("Unhandled response: " + r.kind);
			}
		}
	};
}

function decideIdeReponseType(response: IdeQueryResponseTypes): 'symbol' | 'error' | 'auto-complete' {
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

// If the F* does not support full-buffer queries, we log it and set a flag
function handleIdeProtocolInfo(textDocument: TextDocument, pi: ProtocolInfo, server: Server) {
	if (!pi.features.includes("full-buffer")) {
		// Both fstar and fstar_lax have their own supportsFullBuffer flag, we
		// set both of them here assuming that they both have the same support
		// for full-buffer queries.
		const fstar = server.getFStar(textDocument);
		const fstar_lax = server.getFStar(textDocument, 'lax');
		if (fstar) { fstar.supportsFullBuffer = false; }
		if (fstar_lax) { fstar_lax.supportsFullBuffer = false; }
		console.error("fstar.exe does not support full-buffer queries.");
	}
}

// If we get a response to a symbol query, we store it in the symbol table map
function handleIdeSymbolFactory(server: Server): ((textDocument: TextDocument, response: IdeSymbol) => void) {
	return function (textDocument: TextDocument, response: IdeSymbol) {
		// console.log("Got ide symbol " +JSON.stringify(response));
		const rng = JSON.stringify(response["symbol-range"]);
		const hoverSymbolMap = server.getDocumentState(textDocument.uri)?.hover_symbol_info;
		if (hoverSymbolMap) {
			hoverSymbolMap.set(rng, response);
		}
	};
}

// If we get a proof state dump message, we store it in the proof state map
function handleIdeProofStateFactory(server: Server): ((textDocument: TextDocument, response: IdeProofState) => void) {
	return function (textDocument: TextDocument, response: IdeProofState) {
		// console.log("Got ide proof state " + JSON.stringify(response));
		const range_key = response.location.beg[0];
		const hoverProofStateMap = server.getDocumentState(textDocument.uri)?.hover_proofstate_info;
		if (hoverProofStateMap) {
			// console.log("Setting proof state hover info at line: " +range_key);
			hoverProofStateMap.set(range_key, response);
		}
	};
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
function handleIdeProgressFactory(configurationSettings: fstarVSCodeAssistantSettings, server: Server, connection: ClientConnection): ((textDocument: TextDocument, contents: IdeProgress, lax: boolean) => void) {
	return function (textDocument: TextDocument, contents: IdeProgress, lax: boolean) {
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
				connection.sendDiagnostics({
					uri: textDocument.uri,
					lax: true,
					diagnostics: doc_state.fstar_lax_diagnostics
				});
			}
			else {
				connection.sendDiagnostics({
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
				if (configurationSettings.debug) {
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
			connection.sendStatusOk(msg);
			return;
		}
		if (contents.stage == "full-buffer-fragment-started") {
			const rng = contents.ranges;
			const ok_range = Range.create(mkPosition(rng.beg), mkPosition(rng.end));
			const msg = {
				uri: textDocument.uri,
				ranges: [ok_range]
			};
			connection.sendStatusInProgress(msg);
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
			connection.sendStatusFailed(msg);
			return;
		}
	};
}

// If we get errors and warnings from F*, we send them to VSCode
// as diagnostics, which will show them as squiggles in the editor
function handleIdeDiagnosticsFactory(server: Server, connection: ClientConnection): ((textDocument: TextDocument, response: IdeError[], lax: boolean) => void) {
	return function (textDocument: TextDocument, response: IdeError[], lax: boolean) {
		function ideErrorLevelAsDiagnosticSeverity(level: string): DiagnosticSeverity {
			switch (level) {
				case "warning": return DiagnosticSeverity.Warning;
				case "error": return DiagnosticSeverity.Error;
				case "info": return DiagnosticSeverity.Information;
				default: return DiagnosticSeverity.Error;
			}
		}
		if (!response || !(Array.isArray(response))) {
			connection.sendAlert({ message: "Got invalid response to ide diagnostics request: " + JSON.stringify(response), uri: textDocument.uri });
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
				connection.sendAlert({ message: err.message, uri: textDocument.uri });
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
	};
}

function handleIdeAutoCompleteFactory(server: Server): ((textDocument: TextDocument, response: IdeAutoCompleteResponses) => void) {
	return function (textDocument: TextDocument, response: IdeAutoCompleteResponses) {
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
	};
}
