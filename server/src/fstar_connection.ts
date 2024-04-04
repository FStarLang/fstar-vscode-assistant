import {
	URI
} from 'vscode-uri';

import {
	Position
} from 'vscode-languageserver/node';

import { setTimeout } from 'timers/promises';

import { FStar, FStarConfig } from './fstar';
import { isProtocolInfo, ProtocolInfo, FullBufferQuery, LookupQuery, VfsAdd, AutocompleteRequest, CancelRequest,
	FullBufferQueryResponse, IdeResponse, IdeResponseBase, IdeLookupResponse, IdeAutoCompleteOptions, FStarPosition} from './fstar_messages';

// For full-buffer queries, F* chunks the buffer into fragments and responds
// with several messages, one for each fragment until the first failing
// fragment. The stream of messages ends with a full-buffer-finished. This
// behavior allows for displaying incremental progress while the rest of the
// buffer is being checked.

export class FStarConnection {
	// F*'s IDE protocol requires that each request have a unique query-id.
	// We use a monotonic id.
	private last_query_id: number = 0;

	// TODO(klinvill): Should we have a stronger type for resolve and reject
	// here that is restricted to a response type and error type?
	//
	// Maps query-ids to promises that will be resolved with the appropriate
	// response.
	// Queries may be responded to asynchronously, so we keep a running map
	// of pending responses to handle query responses from F*.
	private pending_responses = new Map<string, {
		resolve: (v: IdeResponseBase) => void,
		reject: (e: Error) => void,
	}>;

	private fullBufferInProgress?: {
		currentReq: FullBufferQuery & {'query-id': string};
		bufferedRequests: {'query-id': string}[];
		bufferedFBR?: FullBufferQuery;
	};

	onFullBufferResponse: (msg: any) => void = _ => {};

	constructor(private fstar: FStar, public debug: boolean) {
		// TODO(klinvill): Should try to spawn F* from within this constructor
		// instead.
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
		await this.restartSolverRequest();
	}

	// Gets the configuration for the F* process.
	fstar_config() : FStarConfig {
		return this.fstar.config;
	}

	////////////////////////////////////////////////////////////////////////////////////
	// Methods to send requests to F*
	////////////////////////////////////////////////////////////////////////////////////

	private sendLineNow(msg: any) {
		const text = JSON.stringify(msg);
		if (this.debug) console.log(">>> " + text);

		if (this.fstar.proc.exitCode != null) {
			const process_name = this.fstar.lax ? "flycheck" : "checker";
			const error_msg = "ERROR: F* " + process_name + " process exited with code " + this.fstar.proc.exitCode;
			throw new Error(error_msg);
		}

		try {
			this.fstar.proc?.stdin?.write(text + '\n');
		} catch (e) {
			const msg = "ERROR: Error writing to F* process: " + e;
			throw new Error(msg);
		}
	}

	private sendReq(req: {'query-id': string}) {
		if (this.fullBufferInProgress) {
			this.fullBufferInProgress.bufferedRequests.push(req);
		} else {
			this.sendLineNow(req);
		}
	}

	private nextQId(): string {
		this.last_query_id += 1;
		return '' + this.last_query_id;
	}

	// Sends a request to the F* process.
	//
	// @param expect_response indicates if a response from F* is expected for
	// this request.
	private async requestCore(msg: any, expect_response = true): Promise<any> {
		const qid = this.nextQId();
		msg["query-id"] = qid;

		this.sendReq(msg);

		if (expect_response) {
			// Only keep track of responses if we expect a response
			return new Promise((resolve, reject) =>
				this.pending_responses.set(qid, {resolve, reject}));
		}
	}

	private async request<Req, Res>(msg: Req): Promise<IdeResponse<Res>> {
		return this.requestCore(msg);
	}

	// Wrapper for a request that doesn't expect a response.
	private silentRequest<Req>(query: Req) {
		this.requestCore(query, false).catch(() => {});
	}

	cancelFBQ(position: FStarPosition) {
		if (!this.fullBufferInProgress) return;
		this.sendLineNow({
			'query-id': this.nextQId(),
			query: "cancel",
			args: {
				"cancel-line": position[0],
				"cancel-column": position[1],
			}
		});
	}

	// full-buffer queries have significantly different behavior than other
	// requests. They initiate a stream of responses from F* that can consist of
	// progress messages, proof-state messages, and status messages. Due to this
	// variety of responses, the full response is returned wrapped within a
	// `StreamedResult` object.
	private fullBufferQuery(query: FullBufferQuery) {
		if (!this.fstar.supportsFullBuffer) {
			throw new Error("ERROR: F* process does not support full-buffer queries");
		}
		if (this.fullBufferInProgress) {
			this.fullBufferInProgress.bufferedFBR = query;
		} else {
			const q = { ...query, 'query-id': this.nextQId() };
			this.sendLineNow(q);
			this.fullBufferInProgress = {
				currentReq: q,
				bufferedRequests: [],
			};
		}
	}

	// Send a request to F* to check the given code.
	fullBufferRequest(code: string, kind: 'full' | 'lax' | 'cache' | 'reload-deps', withSymbols: boolean) {
		this.fullBufferQuery({
			query: "full-buffer",
			args: {
				kind,
				"with-symbols": withSymbols,
				code: code,
				line: 0,
				column: 0
			}
		});
	}

	// Send a request to F* to check the given code up through a position.
	partialBufferRequest(code: string, kind: 'verify-to-position' | 'lax-to-position', position: { line: number, column: number }) {
		this.fullBufferQuery({
			query: "full-buffer",
			args: {
				kind,
				"with-symbols": false,
				code: code,
				line: 0,
				column: 0,
				"to-position": position
			}
		});
	}

	// Look up information about an identifier in a given file.
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#lookup
	async lookupQuery(filePath: string, position: Position, word: string) {
		return this.request<LookupQuery, IdeLookupResponse>({
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
			}
		});
	}

	// Request to map a file into F*'s virtual file system.
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#vfs-add
	async vfsAddRequest(filePath: string, contents: string) {
		return this.request<VfsAdd, null>({
			query: "vfs-add",
			args: {
				filename: filePath,
				contents: contents
			}
		});
	}

	// Request to get a list of completions for the given word (commonly a
	// prefix).
	//
	// For more details, see:
	// https://github.com/FStarLang/FStar/wiki/Editor-support-for-F*#auto-complete
	async autocompleteRequest(word: string) {
		return this.request<AutocompleteRequest, IdeAutoCompleteOptions>({
			"query": "autocomplete",
			"args": {
				"partial-symbol": word,
				"context": "code"
			}
		});
	}

	async restartSolverRequest() {
		const query = {
			query: "restart-solver",
			args: {}
		};
		this.silentRequest(query);
	}

	////////////////////////////////////////////////////////////////////////////////////
	// Methods to handle responses from F*
	////////////////////////////////////////////////////////////////////////////////////

	private handleResponse(msg: any) {
		if (this.debug) console.log("<<< " + JSON.stringify(msg));

		// Either we expect unprompted protocol-info messages, or we expect
		// responses to a query we sent.
		if (isProtocolInfo(msg)) {
			this.handleProtocolInfo(msg as ProtocolInfo);
		} else if (this.fullBufferInProgress) {
			const r = msg as IdeResponseBase;
			// Note: responses to full-buffer queries are sent with query ids
			// with non-strictly incrementing fractional components. E.g. if the
			// query id is 2, the responses can come back with query ids 2, 2.1,
			// 2.1, 2.1, 2.2, 2.3, etc. To get the corresponding request ID, we
			// simply truncate the responses query-id.
			const qid = '' + Math.trunc(Number(r["query-id"]));
			if (qid !== this.fullBufferInProgress.currentReq['query-id']) {
				console.warn('Ill-formed response to full buffer query:', r);
				return;
			}

			this.handleFBQResponse(r);
		} else {
			const r = msg as IdeResponseBase;
			const qid = r["query-id"];
			if (!qid) {
				console.warn('Ill-formed query response message:', r);
				return;
			}

			this.respond(qid, r);
		}
	}

	private handleFBQResponse(msg: any) {
		const done = msg?.kind === 'message' && msg?.level === 'progress' && msg?.contents?.stage === 'full-buffer-finished';
		this.onFullBufferResponse(msg);
		if (done) {
			const old = this.fullBufferInProgress!;
			this.fullBufferInProgress = undefined;
			for (const bufferedReq of old.bufferedRequests) {
				this.sendLineNow(bufferedReq);
			}
			if (old.bufferedFBR) {
				this.fullBufferQuery(old.bufferedFBR);
			}
		}
	}

	// Handles an expected response by fulfilling the promise for the specified
	// query and removing it from the list of pending responses. The promise is
	// resolved with the response.
	private respond(qid: string, response: IdeResponseBase) {
		const pr = this.pending_responses.get(qid);
		if (!pr) {
			console.warn(`No inflight query found for query-id: ${qid}, got response:`, response);
			return;
		}

		this.pending_responses.delete(qid);
		pr.resolve(response);
	}

	// If the F* does not support full-buffer queries, we log it and set a flag
	//
	// This handler exists as part of the FStarConnection class because the
	// ProtocolInfo messages are received unprompted from the F* process after
	// starting it, instead of in response to a query we issue.
	handleProtocolInfo(pi: ProtocolInfo) {
		if (!pi.features.includes("full-buffer")) {
			this.fstar.supportsFullBuffer = false;
			console.error("fstar.exe does not support full-buffer queries.");
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
