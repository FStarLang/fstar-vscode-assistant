import { Position, Range, TextDocument } from 'vscode-languageserver-textdocument';
import { DocumentState, DocumentStateEventHandlers, FStarDocumentState } from './documentState';
import { FStarConfig } from './fstar';
import { fstarVSCodeAssistantSettings } from './settings';
import { TextDocumentPositionParams, CompletionItem, Hover, DefinitionParams, LocationLink, DocumentRangeFormattingParams, TextEdit, PublishDiagnosticsParams, Diagnostic } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import * as cp from 'child_process';
import * as util from 'util';
import { StatusNotificationParams } from './fstarLspExtensions';
import path, { basename, join } from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { AsyncRateLimiter } from './asyncSignals';

function stripSuffix(cPath: string): string {
	if (cPath.endsWith('.c')) { cPath = cPath.slice(0, cPath.length - 2); }
	else if (cPath.endsWith('.h')) { cPath = cPath.slice(0, cPath.length - 2); }
	let base = path.basename(cPath);
	base = base.slice(0, 1).toUpperCase() + base.slice(1);
	return path.join(path.dirname(cPath), base);
}

function cToFstPath(cPath: string): string {
	return stripSuffix(cPath) + '.fst';
}

function cToSourceInfoPath(cPath: string): string {
	return stripSuffix(cPath) + '_source_range_info.json';
}

function cToDiagnosticsPath(cPath: string): string {
	return stripSuffix(cPath) + '_diagnostics.json';
}

interface SourceMapPos {
	line: number; // starts with 1
	column: number; // starts with 1
}

interface SourceMapRange {
	start: SourceMapPos;
	end: SourceMapPos;
}

type PulseSourceRange = SourceMapRange;

interface CSourceRange extends SourceMapRange {
	fileName: string;
	isVerbatim: boolean;
	clangAstNode: string;
}

interface SourceRangeInfoItem {
	pulseRange: PulseSourceRange;
	cRange: CSourceRange;
}

type SourceRangeInfo = SourceRangeInfoItem[];

function smPosLe(a: SourceMapPos, b: SourceMapPos) {
	return a.line < b.line || (a.line === b.line && a.column <= b.column);
}

function smPosToPos(a: SourceMapPos) : Position {
	return { line: a.line - 1, character: a.column - 1 };
}

function smRangeToRange(a: SourceMapRange) : Range {
	return { start: smPosToPos(a.start), end: smPosToPos(a.end) };
}

function posToSmPos(a: Position) : SourceMapPos {
	return { line: a.line + 1, column: a.character + 1 };
}

function rangeToSmRange(a: Range): SourceMapRange {
	return { start: posToSmPos(a.start), end: posToSmPos(a.end) };
}

interface C2PulseConfig {
	c2pulse_exe?: string;
	options?: string[];
}

interface C2PulseResult {
	fstDocument: TextDocument;
	sourceRangeInfo?: SourceRangeInfo;
	errors?: Diagnostic[];
}

export class CDocumentState implements DocumentState {
	cPath: string;
	fstPath: string;
	fstUri: string;

	c2PulseResult?: C2PulseResult;

	get sourceRangeInfo(): SourceRangeInfo | undefined {
		return this.c2PulseResult?.sourceRangeInfo;
	}

	fstarDocumentState?: FStarDocumentState;
	disposed = false;

	constructor(private currentDoc: TextDocument,
			private fstarConfig: FStarConfig,
			private cEvents: DocumentStateEventHandlers,
			private config: fstarVSCodeAssistantSettings,
		) {
		const cPath = URI.parse(currentDoc.uri).fsPath;
		this.cPath = cPath;
		this.fstPath = cToFstPath(this.cPath);
		this.fstUri = URI.from({scheme: 'file', path: this.fstPath}).toString();

		this.cfg = (async () => {
			const cfgFileName = path.join(path.dirname(cPath), 'c2pulse.config.json');
			try {
				const cfg = JSON.parse((await readFile(cfgFileName)).toString()) as C2PulseConfig;
				if (cfg.c2pulse_exe)
					cfg.c2pulse_exe = path.resolve(path.dirname(cfgFileName), cfg.c2pulse_exe);
				return cfg;
			} catch (e) {
				console.log(`Could not read ${cfgFileName}, disabling c2pulse integration`, e);
				return;
			}
		})();
		this.runC2Pulse();
	}

	cfg: Promise<C2PulseConfig | undefined>;

	async runC2PulseCore(cfg: C2PulseConfig): Promise<C2PulseResult> {
		const cDoc = this.currentDoc;
		const tmpDir = await mkdtemp(join(tmpdir(), 'c2pulse-'));
		try {
			const tmpCPath = join(tmpDir, basename(this.cPath));
			const tmpFstPath = join(tmpDir, basename(this.fstPath));

			await writeFile(tmpCPath, cDoc.getText());

			const cmd = cfg.c2pulse_exe ?? 'c2pulse';
			await util.promisify(cp.execFile)(cmd,
					[...(cfg.options ?? []), '--tmpdir=' + tmpDir, this.cPath],
				{
					maxBuffer: 50*1024*1024, // allow up to 50 megabytes of output
				});

			const contents = await readFile(tmpFstPath, 'utf8');
			const sourceRangeInfo = JSON.parse(await readFile(cToSourceInfoPath(tmpCPath), 'utf8'));

			let diagnostics: Diagnostic[] = [];
			try {
				diagnostics = JSON.parse(await readFile(cToDiagnosticsPath(tmpCPath), 'utf8'));
			} catch {}

			const fstDocument = TextDocument.create(
				this.fstUri,
				'fstar',
				cDoc.version,
				contents,
			);

			return {
				fstDocument,
				sourceRangeInfo,
				errors: diagnostics,
			};
		} catch (e) {
			const output = '' + e;

			const errors: Diagnostic[] = [];

			for (const line of output.split('\n')) {
				const m = /^(.*):(\d+):(\d+): error: (.*)$/.exec(line);
				if (m && m[1] == this.cPath) {
					const pos: Position = { line: (m[2] as any) - 1, character: (m[3] as any) - 1 };
					errors.push({
						range: { start: pos, end: pos },
						message: m[4],
					});
				}
			}

			if (errors.length == 0) {
				errors.push({
					range: {
						start: {line: 0, character: 0},
						end: {line: cDoc.lineCount, character: 0},
					},
					message: output,
				});
			}

			const fstDocument = TextDocument.create(this.fstUri, 'fstar', cDoc.version, '');
			return { fstDocument, errors, };
		} finally {
			void rm(tmpDir, {recursive: true});
		}
	}

	c2PulseRateLimiter = new AsyncRateLimiter(250);
	runC2Pulse() {
		this.c2PulseRateLimiter.fire(async () => {
			const cfg = await this.cfg;
			if (!cfg) return;

			this.c2PulseResult = await this.runC2PulseCore(cfg);
			if (this.disposed) return;

			if (this.fstarDocumentState) {
				this.fstarDocumentState?.changeDoc(this.c2PulseResult.fstDocument);
			} else {
				this.fstarDocumentState = FStarDocumentState.make(
					this.c2PulseResult.fstDocument,
					this.fstarConfig,
					this.fstarEventHandlers,
					this.config,
				);
			}
			this.resendNotifs();
		});
	}

	get c2PulseDone(): Promise<void> { return this.c2PulseRateLimiter.settled; }

	c2fstPos(pos: Position): Position {
		const smPos: SourceMapPos = posToSmPos(pos);

		const smRangeSize = (r: SourceMapRange) =>
			1000*(r.end.line - r.start.line) + (r.end.column - r.start.column);

		let smallestEnclosing: SourceRangeInfoItem | undefined;
		for (const item of this.sourceRangeInfo ?? []) {
			if (item.cRange.fileName !== this.cPath) continue;
			if (smPosLe(item.cRange.start, smPos) && smPosLe(smPos, item.cRange.end)) {
				if (smallestEnclosing === undefined || smRangeSize(item.cRange) < smRangeSize(smallestEnclosing.cRange)) {
					smallestEnclosing = item;
				}
			}
		}

		if (smallestEnclosing) {
			if (smallestEnclosing.cRange.isVerbatim) {
				const result = smPosToPos({
					line: smallestEnclosing.pulseRange.start.line + (smPos.line - smallestEnclosing.cRange.start.line),
					column:
						(smPos.line === smallestEnclosing.cRange.start.line ? smallestEnclosing.pulseRange.start.column - 1 : 0) +
						smPos.column,
				});
				return result;
			}

			return smPosToPos(smallestEnclosing.pulseRange.start);
		}

		let lastNotAfter: SourceRangeInfoItem | undefined;
		for (const item of this.sourceRangeInfo ?? []) {
			if (item.cRange.fileName !== this.cPath) continue;
			if (smPosLe(item.cRange.start, smPos)) {
				if (lastNotAfter === undefined || smPosLe(lastNotAfter.cRange.start, item.cRange.start)) {
					lastNotAfter = item;
				}
			}
		}

		if (lastNotAfter)
			return smPosToPos(lastNotAfter.pulseRange.start);

		return { line: 0, character: 0 };
	}
	
	fst2cPos(pos: Position): Position {
		const smPos = posToSmPos(pos);

		let lastBefore: SourceRangeInfoItem | undefined;
		for (const item of this.sourceRangeInfo ?? []) {
			if (item.cRange.fileName !== this.cPath) continue;
			if (smPosLe(item.pulseRange.start, smPos)) {
				if (lastBefore === undefined || smPosLe(lastBefore.pulseRange.start, item.pulseRange.start)) {
					lastBefore = item;
				}
			}
		}

		if (lastBefore) return smPosToPos(lastBefore.cRange.start);

		return { line: 0, character: 0 };
	}
	fst2cRange(range: Range): Range {
		const smRange = rangeToSmRange(range);

		const smRangeSize = (r: SourceMapRange) =>
			1000*(r.end.line - r.start.line) + (r.end.column - r.start.column);

		let smallestEnclosing: SourceRangeInfoItem | undefined;
		for (const item of this.sourceRangeInfo ?? []) {
			if (item.cRange.fileName !== this.cPath) continue;
			if (smPosLe(item.pulseRange.start, smRange.start) && smPosLe(smRange.end, item.pulseRange.end)) {
				if (smallestEnclosing === undefined || smRangeSize(item.pulseRange) < smRangeSize(smallestEnclosing.pulseRange)) {
					smallestEnclosing = item;
				}
			}
		}
		
		if (smallestEnclosing)
			return smRangeToRange(smallestEnclosing.cRange);

		return { start: this.fst2cPos(range.start), end: this.fst2cPos(range.end) };
	}

	dispose(): void {
		this.fstarDocumentState?.dispose();
		this.disposed = true;
	}

	setDebug(debug: boolean): void {
		this.fstarDocumentState?.setDebug(debug);
	}

	changeDoc(newDoc: TextDocument): void {
		this.currentDoc = newDoc;
		this.runC2Pulse();
	}

	verifyAll(params?: { flycheckOnly?: boolean; }): void {
		void this.c2PulseDone.then(() =>
			this.fstarDocumentState?.verifyAll(params));
	}

	verifyToPosition(position: Position): void {
		void this.c2PulseDone.then(() =>
			this.fstarDocumentState?.verifyToPosition(this.c2fstPos(position)));
	}

	laxToPosition(position: Position): void {
		void this.c2PulseDone.then(() =>
			this.fstarDocumentState?.laxToPosition(this.c2fstPos(position)));
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async onCompletion(textDocumentPosition: TextDocumentPositionParams): Promise<CompletionItem[] | undefined> {
		return;
	}

	async onHover(pos: TextDocumentPositionParams): Promise<Hover | undefined> {
		await this.c2PulseDone;
		const hover = await this.fstarDocumentState?.onHover({
			textDocument: {uri: this.fstUri},
			position: this.c2fstPos(pos.position),
		});
		if (!hover) return;
		return {
			...hover,
			range: hover.range ? this.fst2cRange(hover.range) : undefined,
		};
	}

	async onDefinition(defParams: DefinitionParams): Promise<LocationLink[] | undefined> {
		await this.c2PulseDone;
		return this.fstarDocumentState?.onDefinition({
			textDocument: {uri: this.fstUri},
			position: this.c2fstPos(defParams.position),
		});
	}

	// eslint-disable-next-line @typescript-eslint/require-await
	async onDocumentRangeFormatting(formatParams: DocumentRangeFormattingParams): Promise<TextEdit[]> {
		return [];
	}

	async killAndRestartSolver(): Promise<void> {
		await this.fstarDocumentState?.killAndRestartSolver();
	}

	async getTranslatedFst(position: Position): Promise<{ uri: string, position: Position } | undefined> {
		await this.c2PulseDone;
		const fstPos = this.c2fstPos(position);
		if (this.c2PulseResult) {
			await writeFile(this.fstPath, this.c2PulseResult.fstDocument.getText());
		}
		return { uri: this.fstUri, position: fstPos };
	}

	lastFstDiags?: PublishDiagnosticsParams;
	lastStatus?: StatusNotificationParams;
	fstarEventHandlers: DocumentStateEventHandlers = {
		sendDiagnostics: (params) => {
			this.lastFstDiags = params;
			const diagnostics: Diagnostic[] = params.diagnostics.map(diag =>
					({ ...diag, range: this.fst2cRange(diag.range) }));
			if (this?.c2PulseResult?.errors) {
				diagnostics.push(...this.c2PulseResult.errors.map(d => ({...d, source: 'C2Pulse'})));
			}
			this.cEvents.sendDiagnostics({
				uri: this.currentDoc.uri,
				diagnostics,
			});
		},
		sendStatus: (params) => {
			this.lastStatus = params;
			this.cEvents.sendStatus({
				uri: this.currentDoc.uri,
				fragments: params.fragments.map(frag =>
					({ ...frag, range: this.fst2cRange(frag.range) })),
			});
		},
	};
	resendNotifs() {
		this.fstarEventHandlers.sendDiagnostics(this.lastFstDiags ?? {
			uri: this.fstUri,
			diagnostics: [],
		});
		this.fstarEventHandlers.sendStatus(this.lastStatus ?? {
			uri: this.fstUri,
			fragments: [],
		});
	}
}