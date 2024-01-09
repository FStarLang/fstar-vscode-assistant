import {
	Position
} from 'vscode-languageserver/node';

import {
	URI
} from 'vscode-uri';

import { Readable } from 'node:stream';

import { FStar, FStarConfig } from './fstar';
import { AutocompleteRequest, CancelRequest, FStarRange, FullBufferQuery, IdeAutoCompleteResponses, IdeError, IdeProgress, IdeProofState, IdeQueryResponse, IdeQueryResponseTypes, IdeSymbol, LookupQuery, ProtocolInfo, VfsAdd, isIdeQueryResponse, isProtocolInfo } from './fstar_messages';
import { Ok, Result } from './result';
import { FStarError, UnsupportedError } from './errors';


export class FStarConnection {
	last_query_id: number;
	fstar: FStar;

	constructor(fstar: FStar) {
		// F*'s IDE protocol requires that each request have a unique query-id.
		// We use a monotonic id.
		this.last_query_id = 0;
		this.fstar = fstar;
		this.fstar.proc.stdin?.setDefaultEncoding('utf-8');

		// Add custom events that can be listened for
		this.addCustomEvents();
	}

	// Attempts to spawn an F* process, using the given configuration and filePath, and create a connection to it.
	static tryCreateFStarConnection(fstarConfig: FStarConfig, filePath: URI, debug: boolean, lax?: 'lax') : Result<FStarConnection, Error> {
		const fstar = FStar.trySpawnFstar(fstarConfig, filePath, debug, lax);
		if (fstar instanceof Ok) {
			return new Ok(new FStarConnection(fstar.value));
		}
		else {
			return fstar;
		}
	}

	// Kills the F* process and closes the connection
	close() {
		this.fstar.proc.kill();
	}

	// Register an event handler on the F* process. Supports the events
	// supported by a NodeJS `Stream`, along with the following special events
	// on the 'stdout' stream:
	//
	// - 'message': emitted for each valid F* message, emits the message which
	//   is a valid javascript object.
	//
	// - 'message:protocol-info': emitted for each protocol-info message, emits
	//   the contents as a `ProtocolInfo` object.
	//
	// - 'message:ide-progress': emitted for each progress message, emits the
	//   contents as an `IdeProgress` object.
	//
	// - 'message:ide-proof-state': emitted for each proof-state message, emits
	//   the contents as an `IdeProofState` object.
	//
	// - 'message:ide-info': emitted for each info message, emits the contents
	//   as-is.
	//
	// - 'message:ide-symbol': emitted for each symbol message, emits the
	//   response as an `IdeSymbol` object.
	//
	// - 'message:ide-error': emitted for each error message, emits the response
	//   as an `IdeError[]` object.
	//
	// - 'message:ide-auto-complete': emitted for each auto-complete message,
	//   emits the response as an `IdeAutoCompleteResponses` object.
	on(stream: 'stdout' | 'stderr' | 'stdin', event: string, handler: (...args:any[]) => void) {
		let fstar_stream;
		if (stream === 'stdout') {
			fstar_stream = this.fstar.proc.stdout;
		} else if (stream === 'stderr') {
			fstar_stream = this.fstar.proc.stderr;
		} else if (stream === 'stdin') {
			fstar_stream = this.fstar.proc.stdin;
		}
		if (fstar_stream)
			fstar_stream.on(event, handler);
		else
			console.warn("Could not retrieve the" + stream + "stream for this F* proccess");
	}

	// Custom events that will be emitted on top of 'data' events. These events
	// can be listened for.
	private addCustomEvents() {
		const stdout_stream = this.fstar.proc.stdout;
		if (!stdout_stream) {
			console.warn("Could not retrieve the stdout stream to register custom event handlers");
			return;
		}
		const handler = (msg: object) => this.emitPerMessage(stdout_stream, msg);
		// The bufferHandler buffers up received input until it finds a valid
		// message. The wrapped handler will then be called with the parsed
		// valid message. This handles receiving fragmented messages or multiple
		// messages over the stream from the F* process.
		const bufferHandler = FStarConnection.bufferedMessageHandlerFactory(handler);
		// Note: listeners stack rather than overwrite each other so other
		// 'data' handlers won't overwrite our custom events handler.
		stdout_stream.on('data', bufferHandler);
	}

	// Emits the appropriate events for a given message. This helper adds the
	// following events:
	// - 'message': emitted for each valid F* message, emits the message which
	//   is a valid javascript object.
	// - 'message:protocol-info': emitted for each protocol-info message, emits
	//   the contents as a `ProtocolInfo` object.
	// - 'message:ide-progress': emitted for each progress message, emits the
	//   contents as an `IdeProgress` object.
	// - 'message:ide-proof-state': emitted for each proof-state message, emits
	//   the contents as an `IdeProofState` object.
	// - 'message:ide-info': emitted for each info message, emits the contents
	//   as-is.
	// - 'message:ide-symbol': emitted for each symbol message, emits the
	//   response as an `IdeSymbol` object.
	// - 'message:ide-error': emitted for each error message, emits the response
	//   as an `IdeError[]` object.
	// - 'message:ide-auto-complete': emitted for each auto-complete message,
	//   emits the response as an `IdeAutoCompleteResponses` object.
	private emitPerMessage(stream: Readable, msg: object) {
		stream.emit('message', msg);

		// Events for specific message types
		if (isProtocolInfo(msg)) {
			stream.emit('message:protocol-info', msg as ProtocolInfo);
		} else if (isIdeQueryResponse(msg)) {
			const r = msg as IdeQueryResponse;
			if (r.kind === 'message' && r.level === 'progress') {
				stream.emit('message:ide-progress', r.contents as IdeProgress);
			} else if (r.kind === 'message' && r.level === 'proof-state') {
				stream.emit('message:ide-proof-state', r.contents as IdeProofState);
			} else if (r.kind === 'message' && r.level === 'info') {
				stream.emit('message:ide-info', r.contents);
			} else if (r.kind === "response" && r.response) {
				const responseType = this.decideIdeReponseType(r.response);
				if (responseType === 'symbol') {
					stream.emit('message:ide-symbol', r.response as IdeSymbol);
				} else if (responseType === 'error') {
					stream.emit('message:ide-error', r.response as IdeError[]);
				} else if (responseType === 'auto-complete') {
					stream.emit('message:ide-auto-complete', r.response as IdeAutoCompleteResponses);
				} else {
					console.warn("No additional events emitted for unrecognized message: " + JSON.stringify(msg));
				}
			} else {
				console.warn("No additional events emitted for unrecognized message: " + JSON.stringify(msg));
			}
		} else {
			console.warn("No additional events emitted for unrecognized message: " + JSON.stringify(msg));
		}
	}

	private decideIdeReponseType(response: IdeQueryResponseTypes): 'symbol' | 'error' | 'auto-complete' {
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

	// All messages from F* are expected to be valid JSON objects.
	//
	// TODO(klinvill): this should likely be refactored into `fstar_messages.ts` and
	// should check the structure of a message, not just that it's valid JSON. A
	// better method could return either the appropriate message object, or an error
	// otherwise, so that the parsing could be moved out of these handlers and into
	// the same file as the message definitions.
	private static is_valid_fstar_message(entry: string): boolean {
		try {
			JSON.parse(entry);
			return true;
		}
		catch (err) {
			return false;
		}
	}

	// Returns a message handler meant to run on top of a `Stream`'s 'data'
	// handler. This handler will buffer received data to handle fragmented
	// messages. It will invoke the given `handler` on each received valid F*
	// message.
	//
	// Note that this function is created as a closure to keep the buffer scoped
	// only to this function. The factory function exists to make unit-testing
	// easier (creating a new function is like resetting the closure state).
	static bufferedMessageHandlerFactory(handler: (message: object) => void) {
		// TODO(klinvill): Gabriel suggests removing fragmentation (if another
		// solution can be found).
		//
		// Stateful buffer to store partial messages. Messages appear to be
		// fragmented into 8192 byte chunks if they exceed this size.
		let buffer = "";

		return function (data: string) {
			const lines = data.toString().split('\n');

			const valid_messages: object[] = [];
			for (const line of lines) {
				if (FStarConnection.is_valid_fstar_message(line)) {
					// We assume that fragmented messages will always be read
					// sequentially. This is a reasonable assumption to make since
					// messages should be delivered over a local IO stream (which is
					// FIFO and provides reliable delivery) from a single-threaded
					// F* IDE process. Because of this assumption, receiving a
					// non-fragmented message while the buffer is non-empty implies
					// that some error occured before the process could finish
					// sending a message, so the buffer is discarded.
					if (buffer !== "") {
						console.error("Partially buffered message discarded: " + buffer);
					}
					buffer = "";
					// Valid messages are valid JSON objects
					valid_messages.push(JSON.parse(line));
				} else {
					// We assume that invalid messages are just message fragments.
					// We therefore add this fragment to the buffer until the full
					// message is received.
					buffer += line;
					// The message fragment we received may be the last fragment
					// needed to complete a message. We therefore check here to see
					// if the buffer constitutes a valid message.
					if (FStarConnection.is_valid_fstar_message(buffer)) {
						// Valid messages are valid JSON objects
						valid_messages.push(JSON.parse(buffer));
						buffer = "";
					}
				}
			}

			// Invoke the message handler for each received message in-order
			valid_messages.forEach(message => handler(message));
		};
	}

	// Utilities to send messages to an F* process. Sending a request wraps the
	// request with a fresh query-id.
	sendRequest(msg: any, debug: boolean) : Result<void, FStarError | Error> {
		const qid = this.last_query_id;
		this.last_query_id = qid + 1;
		msg["query-id"] = '' + (qid + 1);
		const text = JSON.stringify(msg);
		if (debug) {
			console.log(">>> " + text);
		}
		if (this.fstar.proc.exitCode != null) {
			const process_name = this.fstar.lax ? "flycheck" : "checker";
			const error_msg = "ERROR: F* " + process_name + " process exited with code " + this.fstar.proc.exitCode;
			return new FStarError(error_msg);
		}
		else {
			try {
				this.fstar.proc?.stdin?.write(text);
				this.fstar.proc?.stdin?.write("\n");
				return new Ok(undefined);
			} catch (e) {
				const msg = "ERROR: Error writing to F* process: " + e;
				return new Error(msg);
			}
		}
	}

	sendFullBufferRequest(code: string, kind: 'full' | 'lax' | 'cache' | 'reload-deps', withSymbols: boolean, debug: boolean) : Result<void, UnsupportedError | FStarError | Error> {
		if (!this.fstar.supportsFullBuffer) {
			return new UnsupportedError("ERROR: F* process does not support full-buffer queries");
		}
		const push_context: FullBufferQuery = {
			query: "full-buffer",
			args: {
				kind,
				"with-symbols": withSymbols,
				code: code,
				line: 0,
				column: 0
			}
		};
		return this.sendRequest(push_context, debug);
	}

	sendPartialBufferRequest(code: string, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }, debug: boolean) : Result<void, UnsupportedError | FStarError | Error> {
		if (!this.fstar.supportsFullBuffer) {
			return new UnsupportedError("ERROR: F* process does not support full-buffer queries");
		}
		const push_context: FullBufferQuery = {
			query: "full-buffer",
			args: {
				kind,
				"with-symbols": false,
				code: code,
				line: 0,
				column: 0,
				"to-position": position
			}
		};
		return this.sendRequest(push_context, debug);
	}

	sendLookupQuery(filePath: string, position: Position, word: string, range: FStarRange, debug: boolean) : Result<void, FStarError | Error> {
		const query: LookupQuery = {
			query: "lookup",
			args: {
				context: "code",
				symbol: word,
				"requested-info": ["type", "documentation", "defined-at"],
				location: {
					filename: filePath,
					line: position.line + 1,
					column: position.character
				},
				"symbol-range": range
			}
		};
		return this.sendRequest(query, debug);
	}

	sendVfsAddRequest(filePath: string, contents: string, debug: boolean) : Result<void, FStarError | Error> {
		const query: VfsAdd = {
			query: "vfs-add",
			args: {
				filename: filePath,
				contents: contents
			}
		};
		return this.sendRequest(query, debug);
	}

	sendAutocompleteRequest(word: string, debug: boolean) : Result<void, FStarError | Error> {
		const query: AutocompleteRequest = {
			"query": "autocomplete",
			"args": {
				"partial-symbol": word,
				"context": "code"
			}
		};
		return this.sendRequest(query, debug);
	}

	sendCancelRequest(range: { line: number; character: number }, debug: boolean) : Result<void, FStarError | Error> {
		const query: CancelRequest = {
			query: "cancel",
			args: {
				"cancel-line": range.line + 1,
				"cancel-column": range.character
			}
		};
		return this.sendRequest(query, debug);
	}

	sendRestartSolverRequest(debug: boolean) : Result<void, FStarError | Error> {
		const query = {
			query: "restart-solver",
			args: {}
		};
		return this.sendRequest(query, debug);
	}
}
