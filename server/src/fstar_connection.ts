import {
	Position
} from 'vscode-languageserver/node';

import {
	URI
} from 'vscode-uri';

import { FStar, FStarConfig } from './fstar';
import { Ok, Result } from './result';


export class FStarConnection {
	last_query_id: number;
	fstar: FStar;

	constructor(fstar: FStar) {
		// F*'s IDE protocol requires that each request have a unique query-id.
		// We use a monotonic id.
		this.last_query_id = 0;
		this.fstar = fstar;
		this.fstar.proc.stdin?.setDefaultEncoding('utf-8');
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

	// Register an event handler on the F* process. Supports the special event
	// 'message' which triggers on each valid F* message, as well as any event
	// supported by a NodeJS `Stream`.
	on(stream: 'stdout' | 'stderr' | 'stdin', event: string, handler: (...args:any[]) => void) {
		let fstar_stream;
		if (stream === 'stdout') {
			fstar_stream = this.fstar.proc.stdout;
		} else if (stream === 'stderr') {
			fstar_stream = this.fstar.proc.stderr;
		} else if (stream === 'stdin') {
			fstar_stream = this.fstar.proc.stdin;
		}

		// Add a higher-level message handler that will invoke the handler on
		// each valid F* message. The message handler incorporates buffering to
		// handle fragmented messages.
		if (event === 'message') {
			const messageHandler = FStarConnection.bufferedMessageHandlerFactory(handler);
			fstar_stream?.on('data', messageHandler);
		} else {
			// Otherwise passes the event handler through to the stream
			fstar_stream?.on(event, handler);
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
	static bufferedMessageHandlerFactory(handler: (message: string) => void) {
		// TODO(klinvill): Gabriel suggests removing fragmentation (if another
		// solution can be found).
		//
		// Stateful buffer to store partial messages. Messages appear to be
		// fragmented into 8192 byte chunks if they exceed this size.
		let buffer = "";

		return function (data: string) {
			const lines = data.toString().split('\n');

			const valid_lines: string[] = [];
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
					valid_lines.push(line);
				} else {
					// We assume that invalid messages are just message fragments.
					// We therefore add this fragment to the buffer until the full
					// message is received.
					buffer += line;
					// The message fragment we received may be the last fragment
					// needed to complete a message. We therefore check here to see
					// if the buffer constitutes a valid message.
					if (FStarConnection.is_valid_fstar_message(buffer)) {
						valid_lines.push(buffer);
						buffer = "";
					}
				}
			}

			// Invoke the message handler for each received message in-order.
			valid_lines.forEach(message => handler(message));
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
