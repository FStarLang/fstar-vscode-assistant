/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext, Command } from 'vscode';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	Range,
	Position
} from 'vscode-languageclient/node';
import { StatusNotificationParams, killAllNotification, killAndRestartSolverNotification, restartNotification, statusNotification, verifyToPositionNotification } from './fstarLspExtensions';

let client: LanguageClient;


interface fstarVSCodeAssistantSettings {
	verifyOnOpen: boolean;
	verifyOnSave: boolean;
	flyCheck: boolean;
	debug: boolean;
	showLightCheckIcon: boolean;
}

let fstarVSCodeAssistantSettings: fstarVSCodeAssistantSettings = {
	verifyOnOpen: false,
	verifyOnSave: true,
	flyCheck: true,
	debug: false,
	showLightCheckIcon: true
};

// This is the green dashed line icon that will be displayed in the gutter
const gutterIconOk = vscode.window.createTextEditorDecorationType({
	gutterIconSize: '20%',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'checked.svg')
});

// This is the blue dashed line icon that will be displayed in the gutter
const gutterIconLax = vscode.window.createTextEditorDecorationType({
	gutterIconSize: '20%',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'laxcheck.svg')
});

// This is the hourglass icon that will be displayed in the gutter
const gutterIconHourglass = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'hourglass.svg')
});

// This is the "..." icon that will be displayed in the gutter
const gutterIconStarted = vscode.window.createTextEditorDecorationType({
	gutterIconSize: '100%',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'started.svg')
});

// A map from file URI to the verified gutter decorations positions for it
const gutterOkDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the laxcheck gutter decorations positions for it
const gutterLaxDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the hourglass gutter decoration positions for it
const proofInProgressDecorationMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the started gutter decoration positions for it
const proofStartedDecorationMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A background color for text being verified: Not currently used
const inProgressBackground = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(100, 0, 255, 0.5)'
});

function posToCode(range: Position): vscode.Position {
	return new vscode.Position(range.line, range.character);
}

function rangeToCode(range: Range): vscode.Range {
	return new vscode.Range(posToCode(range.start), posToCode(range.end));
}

function handleStatus(params: StatusNotificationParams) {
	const started: vscode.Range[] = [];
	const inProgress: vscode.Range[] = [];
	const ok: vscode.Range[] = [];
	const lax: vscode.Range[] = [];

	for (const frag of params.fragments) {
		const r = rangeToCode(frag.range);
		switch (frag.kind) {
			case 'ok':
				ok.push(r); break;
			case 'failed':
			case 'light-failed':
				break;
			case 'lax-ok':
			case 'light-ok':
				lax.push(r); break;
			case 'in-progress':
				inProgress.push(r); break;
			case 'started':
				started.push(r); break;
		}
	}

	const uri = params.uri;
	proofStartedDecorationMap.set(uri, started);
	gutterLaxDecorationsMap.set(uri, lax);
	gutterOkDecorationsMap.set(uri, ok);
	proofInProgressDecorationMap.set(uri, inProgress);

	if (vscode.window.visibleTextEditors.some(ed => ed.document.uri.toString() === params.uri)) {
		updateDecorations();
	}
}

function updateDecorations() {
	for (const editor of vscode.window.visibleTextEditors) {
		const uri = editor.document.uri.toString();
		editor.setDecorations(gutterIconStarted, proofStartedDecorationMap.get(uri) ?? []);
		editor.setDecorations(gutterIconHourglass, proofInProgressDecorationMap.get(uri) ?? []);
		editor.setDecorations(gutterIconOk, gutterOkDecorationsMap.get(uri) ?? []);
		editor.setDecorations(gutterIconLax,
			fstarVSCodeAssistantSettings.showLightCheckIcon ?
				gutterLaxDecorationsMap.get(uri) ?? [] : []);
	}
}

export async function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'main.js')
	);

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
		}
	};

	// Options to control the language client
	const clientOptions: LanguageClientOptions = {
		// Register the server for plain text documents
		documentSelector: [{ scheme: 'file', language: 'fstar'}],
		diagnosticCollectionName: 'fstar',
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'fstar-vscode-assistant',
		'F* VSCode Assistant',
		serverOptions,
		clientOptions
	);
	
	client.onNotification(statusNotification, status => handleStatus(status));
	vscode.window.onDidChangeVisibleTextEditors(() => updateDecorations());

	// register a command for Ctrl+.
	context.subscriptions.push(vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/verify-to-position', textEditor =>
		client.sendNotification(verifyToPositionNotification, {
			uri: textEditor.document.uri.toString(),
			lax: false,
			position: textEditor.selection.active,
		})));

	context.subscriptions.push(vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/restart', textEditor =>
		client.sendNotification(restartNotification, { uri: textEditor.document.uri.toString() })));

	// register a command for Ctrl+Shift+.
	context.subscriptions.push(vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/lax-to-position', textEditor =>
		client.sendNotification(verifyToPositionNotification, {
			uri: textEditor.document.uri.toString(),
			lax: true,
			position: textEditor.selection.active,
		})));

	context.subscriptions.push(vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/kill-and-restart-solver', textEditor =>
		client.sendNotification(killAndRestartSolverNotification, { uri: textEditor.document.uri.toString() })));
	
	context.subscriptions.push(vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/kill-all', () =>
		client.sendNotification(killAllNotification, {})));

	workspace.onDidChangeConfiguration((event) => {
		const cfg = workspace.getConfiguration('fstarVSCodeAssistant');
		fstarVSCodeAssistantSettings = {
			verifyOnOpen: cfg.get('verifyOnOpen', fstarVSCodeAssistantSettings.verifyOnOpen),
			verifyOnSave: cfg.get('verifyOnSave', fstarVSCodeAssistantSettings.verifyOnSave),
			flyCheck: cfg.get('flyCheck', fstarVSCodeAssistantSettings.flyCheck),
			debug: cfg.get('debug', fstarVSCodeAssistantSettings.debug),
			showLightCheckIcon: cfg.get('showLightCheckIcon', fstarVSCodeAssistantSettings.showLightCheckIcon),
		};
	});

	await client.start();
}

export async function deactivate() {
	await client?.stop();
}
