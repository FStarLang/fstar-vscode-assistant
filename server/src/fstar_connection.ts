import {
	URI
} from 'vscode-uri';

import {
	Position
} from 'vscode-languageserver/node';

import { setTimeout } from 'timers/promises';

import { FStar, FStarConfig } from './fstar';
import { isProtocolInfo, IdeProgress, ProtocolInfo, IdeProofState, IdeQueryResponse, IdeQueryResponseTypes, IdeSymbol, IdeError, IdeAutoCompleteResponses, FullBufferQuery, FStarRange, LookupQuery, VfsAdd, AutocompleteRequest, CancelRequest } from './fstar_messages';

// For full-buffer queries, F* chunks the buffer into fragments and responds
// with several messages, one for each fragment until the first failing
// fragment. The series of messages ends with a full-buffer-finished. This
// behavior allows for displaying incremental progress while the rest of the
// buffer is being checked. `partialResult` is the type of these partially
// completed queries.
//
// TODO(klinvill): would be nice to have this be a more informative type than
// potentially containing `undefined`. E.g. to have Continuing and Done types.
//
// TODO(klinvill): would also be nice to have an iterator interface for
// partialResults (or for a wrapper type like streamResults)
export type partialResult<T> = Promise<[T, partialResult<T> | undefined]>;

export class FStarConnection {
	private last_query_id: number;
	// TODO(klinvill): Should we have a stronger type for resolve and reject
	// here that is restricted to a response type and error type?
	//
	// Maps query-ids to promises that will be resolved with the appropriate
	// response.
	private pending_responses: Map<number, {resolve: (v: any) => void, reject: (e: any) => void, is_stream: boolean}>;
	private fstar: FStar;
	debug: boolean;

	constructor(fstar: FStar, debug: boolean) {
		this.debug = debug;

		// F*'s IDE protocol requires that each request have a unique query-id.
		// We use a monotonic id.
		this.last_query_id = 0;

		// Queries may be responded to asynchronously, so we keep a running map
		// of pending responses to handle query responses from F*.
		this.pending_responses = new Map();

		// TODO(klinvill): Should try to spawn F* from within this constructor
		// instead.
		this.fstar = fstar;
		this.fstar.proc.stdin?.setDefaultEncoding('utf-8');

		// Register message handlers that will resolve the appropriate pending
		// response promises for each query.
		//
		// The bufferedHandler buffers up received input until it finds a valid
		// message. The wrapped handler will then be called with the parsed
		// valid message. This handles receiving fragmented messages or multiple
		// messages over the stream from the F* process.
		const bufferedHandler = FStarConnection.bufferedMessageHandlerFactory((msg: object) => this.handleResponse(msg));
		this.fstar.proc.stdout?.on('data', bufferedHandler);

		// F* error messages are just printed out
		const fstar_proc_name = this.fstar.lax ? 'fstar lax' : 'fstar';
		this.fstar.proc.stderr?.on('data', (data) => { console.error(`${fstar_proc_name} stderr: ${data}`); });
	}

	// Attempts to spawn an F* process, using the given configuration and
	// filePath, and create a connection to it.
	//
	// @throws {Error} from `trySpawnFstar`
	static tryCreateFStarConnection(fstarConfig: FStarConfig, filePath: URI, debug: boolean, lax?: 'lax') : FStarConnection | undefined {
		const fstar = FStar.trySpawnFstar(fstarConfig, filePath, debug, lax);
		if (fstar)
			return new FStarConnection(fstar, debug);
		else
			return undefined;
	}

	// Kills the F* process and closes the connection
	close() {
		this.fstar.proc.kill();
	}

	async restartSolver() {
		this.fstar.killZ3SubProcess(this.debug);

		// Wait for a second for processes to die before restarting the solver
		await setTimeout(1000);
		this.restartSolverRequest();
	}

	// Gets the configuration for the F* process.
	fstar_config() : FStarConfig {
		return this.fstar.config;
	}

	////////////////////////////////////////////////////////////////////////////////////
	// Methods to send requests to F*
	////////////////////////////////////////////////////////////////////////////////////

	// Sends a request to the F* process.
	//
	// @param expect_response indicates if a response from F* is expected for
	// this request.
	private async request(msg: any, expect_response = true, is_stream = false): Promise<any> {
		// TODO(klinvill): do we need to worry about racing requests here that might result in the same query-id? That would cause issues when tracking responses.
		const qid = this.last_query_id + 1;
		this.last_query_id = qid;
		msg["query-id"] = '' + qid;
		const text = JSON.stringify(msg);
		if (this.debug) {
			console.log(">>> " + text);
		}
		if (this.fstar.proc.exitCode != null) {
			const process_name = this.fstar.lax ? "flycheck" : "checker";
			const error_msg = "ERROR: F* " + process_name + " process exited with code " + this.fstar.proc.exitCode;
			throw new Error(error_msg);
		}

		try {
			this.fstar.proc?.stdin?.write(text);
			this.fstar.proc?.stdin?.write("\n");
		} catch (e) {
			const msg = "ERROR: Error writing to F* process: " + e;
			throw new Error(msg);
		}

		if (expect_response) {
			// Only keep track of responses if we expect a response
			return new Promise((resolve, reject) =>
				this.pending_responses.set(qid, {resolve, reject, is_stream}));
		}
	}

	// Send a request to F* to check the given code.
	async fullBufferRequest(code: string, kind: 'full' | 'lax' | 'cache' | 'reload-deps', withSymbols: boolean): partialResult<IdeProgress> {
		if (!this.fstar.supportsFullBuffer) {
			throw new Error("ERROR: F* process does not support full-buffer queries");
		}
		const query: FullBufferQuery = {
			query: "full-buffer",
			args: {
				kind,
				"with-symbols": withSymbols,
				code: code,
				line: 0,
				column: 0
			}
		};

		const expect_response = true;
		const is_stream = true;
		return this.request(query, expect_response, is_stream);
	}

	// Send a request to F* to check the given code up through a position.
	//
	// TODO(klinvill): Since this FStarConnection object is only for one F*
	// process (lax or not), do we need the `kind` argument here or can we infer
	// it from the F* process?
	async partialBufferRequest(code: string, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }): partialResult<IdeProgress> {
		if (!this.fstar.supportsFullBuffer) {
			throw new Error("ERROR: F* process does not support full-buffer queries");
		}
		const query: FullBufferQuery = {
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

		const expect_response = true;
		const is_stream = true;
		return this.request(query, expect_response, is_stream);
	}

	// Look up information about an identifier in a given file.
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#lookup
	async lookupQuery(filePath: string, position: Position, word: string, range: FStarRange): Promise<IdeSymbol> {
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
		return this.request(query);
	}

	// Request to map a file into F*'s virtual file system.
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#vfs-add
	async vfsAddRequest(filePath: string, contents: string) {
		const query: VfsAdd = {
			query: "vfs-add",
			args: {
				filename: filePath,
				contents: contents
			}
		};

		const expect_response = false;
		this.request(query, expect_response);
	}

	// Request to get a list of completions for the given word (commonly a
	// prefix).
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#auto-complete
	async autocompleteRequest(word: string) : Promise<IdeAutoCompleteResponses> {
		const query: AutocompleteRequest = {
			"query": "autocomplete",
			"args": {
				"partial-symbol": word,
				"context": "code"
			}
		};
		return this.request(query);
	}

	// A Cancel message should be sent to F* when the document changes at a
	// given range, to stop it from verifying the part of the buffer that has
	// changed
	//
	// TODO(klinvill): What exactly does this do? I copied the comment with the
	// messages interface definition. Should also be documented in
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#cancel
	async cancelRequest(range: { line: number; character: number }) {
		const query: CancelRequest = {
			query: "cancel",
			args: {
				"cancel-line": range.line + 1,
				"cancel-column": range.character
			}
		};

		// TODO(klinvill): I believe there's no responses to cancel requests, is
		// that correct?
		const expect_response = false;
		this.request(query, expect_response);
	}

	async restartSolverRequest() {
		const query = {
			query: "restart-solver",
			args: {}
		};

		// TODO(klinvill): I believe there's no responses to restart-solver requests, is
		// that correct?
		const expect_response = false;
		this.request(query, expect_response);
	}

	////////////////////////////////////////////////////////////////////////////////////
	// Methods to handle responses from F*
	////////////////////////////////////////////////////////////////////////////////////

	private handleResponse(msg: object) {
		// Events for specific message types
		if (isProtocolInfo(msg)) {
			this.handleProtocolInfo(msg as ProtocolInfo);
		} else {
			// Either we expect unprompted protocol-info messages, or we expect
			// responses to a query we sent.
			const r = msg as IdeQueryResponse;
			// TODO(klinvill): it appears that responses to full-buffer queries
			// are sent with query ids with incrementing fractional components.
			// E.g. if the query id is 2, the responses seem to come back with
			// query ids 2, 2.1, 2.2, 2.3, etc. To deal with this behavior I
			// truncate the responses query-id. Is this the proper behavior for
			// this case?
			const qid = Math.trunc(Number(r["query-id"]));
			if (!qid) {
				console.warn(`Ill-formed query response message: ${r}`);
				return;
			}

			if (r.kind === 'message' && r.level === 'progress') {
				const response = r.contents as IdeProgress;
				// Progress responses are sent as a stream of messages. The last
				// message is always "full-buffer-finished".
				const done = response.stage === 'full-buffer-finished';
				this.respondStream(qid, response, done);
			} else if (r.kind === 'message' && r.level === 'proof-state') {
				// TODO(klinvill): What queries can prompt proof-state status messages? Are they part of a stream (like responses to full-buffer queries)?
				this.respond(qid, r.contents as IdeProofState);
			} else if (r.kind === 'message' && r.level === 'info') {
				// TODO(klinvill): info messages are just logged and don't resolve the corresponding pending_responses promise. Is this the right behavior (that info messages are just extraneous and should be logged and ignored)?
				console.log("Info: " + r.contents);
			} else if (r.kind === "response" && r.response) {
				const responseType = FStarConnection.decideIdeReponseType(r.response);
				if (responseType === 'symbol') {
					const pr = this.pending_responses.get(qid);
					if (!pr) {
						console.warn(`No inflight query found for query-id: ${qid}, got response: ${JSON.stringify(r.response)}.`);
						return;
					}
					// TODO(klinvill): can symbol messages be sent in response
					// to a request that results in streams (like full-buffer
					// queries)? I seem to be seeing this for some full-buffer
					// queries. I therefore check below if the response is part
					// of a stream and handle it accordingly.
					if (pr.is_stream) {
						// TODO(klinvill): Can a symbol message end a full-buffer stream? Or will it always only end with a full-buffer-finished message?
						this.respondStream(qid, r.response, false);
					}
					else {
						this.respond(qid, r.response);
					}
				} else if (responseType === 'error') {
					// TODO(klinvill): Should we instead reject the promise
					// here? Or pass along the error responses as the resolved
					// promise value?
					//
					// TODO(klinvill): What requests can IdeError be sent in
					// response to? All of them? Right now there's not a request
					// method with a return type that include IdeError.
                    const pr = this.pending_responses.get(qid);
					if (!pr) {
						console.warn(`No inflight query found for query-id: ${qid}, got response: ${JSON.stringify(r.response)}.`);
						return;
					}
					// Errors can be sent in response to a request that results
                    // in streams (like full-buffer queries). We therefore check
                    // if the response is part of a stream and handle it
                    // accordingly.
					if (pr.is_stream) {
						// TODO(klinvill): Can an error message end a full-buffer stream? Or will it always only end with a full-buffer-finished message?
						this.respondStream(qid, r.response as IdeError[], false);
					} else {
						this.respond(qid, r.response as IdeError[]);
					}
				} else if (responseType === 'auto-complete') {
					this.respond(qid, r.response as IdeAutoCompleteResponses);
				} else {
					console.warn(`Response message not recognized: ${JSON.stringify(r)}` );
				}
			} else {
				console.warn(`Message not recognized: ${JSON.stringify(r)}`);
			}

		}
	}

	// Handles an expected response by fulfilling the promise for the specified
	// query and removing it from the list of pending responses. The promise is
	// resolved with the response.
	private respond(qid: number, response: object) {
		const pr = this.pending_responses.get(qid);
		if (!pr) {
			console.warn(`No inflight query found for query-id: ${qid}, got response: ${JSON.stringify(response)}.`);
			return;
		}

		this.pending_responses.delete(qid);
		pr.resolve(response);
	}

	// Handles an expected response that is part of a stream of responses. The
	// promise is resolved with a partialResult. If this is the last expected
	// response in the stream, the second element in the partialResult will be
	// undefined. Otherwise, the second element in the partialResult is a
	// promise that will be resolved with the next response in the stream.
	private respondStream(qid: number, response: object, done: boolean) {
		if (done) {
			this.respond(qid, [response, undefined]);
		} else {
			const pr = this.pending_responses.get(qid);
			if (!pr) {
				console.warn(`No inflight query found for query-id: ${qid}, got response: ${JSON.stringify(response)}.`);
				return;
			}

			// The current promise needs to be resolved with the current
			// response so we create a new promise to become the next pending
			// response.
			const new_promise = new Promise((resolve, reject) => {
				this.pending_responses.set(qid, {resolve, reject, is_stream: true});
			});
			pr.resolve([response, new_promise]);
		}
	}

	// If the F* does not support full-buffer queries, we log it and set a flag
	//
	// This handler exists as part of the FStarConnection class because the
	// ProtocolInfo messages are received unprompted from the F* process after
	// starting it, instead of in response to a query we issue.
	//
	// TODO(klinvill): previously the supportsFullBuffer was set for both the
	// lax and non-lax F* processes when a single protocol info message was
	// received. I changed the behavior here to only set it for the process the
	// response comes from. Does this change break anything?
	handleProtocolInfo(pi: ProtocolInfo) {
		if (!pi.features.includes("full-buffer")) {
			this.fstar.supportsFullBuffer = false;
			console.error("fstar.exe does not support full-buffer queries.");
		}
	}

	private static decideIdeReponseType(response: IdeQueryResponseTypes): 'symbol' | 'error' | 'auto-complete' {
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

	// Returns a message handler meant to run on top of a `Stream`'s 'data'
	// handler. This handler will buffer received data to handle fragmented
	// messages. It will invoke the given `handler` on each received valid F*
	// message.
	//
	// Note that this function is created as a closure to keep the buffer scoped
	// only to this function. The factory function exists to make unit-testing
	// easier (creating a new function is like resetting the closure state).
	static bufferedMessageHandlerFactory(handler: (message: object) => void) {
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
						console.warn("Partially buffered message discarded: " + buffer);
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

	// All messages from F* are expected to be valid JSON objects.
	//
	// TODO(klinvill): this should likely be refactored into `fstar_messages.ts` and
	// potentially check the structure of a message, not just that it's valid JSON. A
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
}
