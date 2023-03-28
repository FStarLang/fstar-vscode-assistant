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
	TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;


interface fstarVSCodeAssistantSettings {
	verifyOnOpen: boolean;
	verifyOnSave: boolean;
	flyCheck: boolean;
	debug: boolean;
	showFlyCheckIcon: boolean;
	showLightCheckIcon: boolean;
}

let fstarVSCodeAssistantSettings: fstarVSCodeAssistantSettings = {
	verifyOnOpen: false,
	verifyOnSave: true,
	flyCheck: true,
	debug: false,
	showFlyCheckIcon: true,
	showLightCheckIcon: true
};

// This is the check mark icon that will be displayed in the gutter
const gutterIconOk = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'check.svg')
});

// This is the check mark icon that will be displayed in the gutter
const gutterIconLax = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'lax.svg')
});

// This is the hourglass icon that will be displayed in the gutter
const gutterIconHourglass = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'hourglass.svg')
});

// This is the hourglass icon that will be displayed in the gutter
const gutterIconEye = vscode.window.createTextEditorDecorationType({
	gutterIconSize: 'contain',
	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'eye.svg')
});

// A map from file URI to the gutter decorations positions for it
const gutterOkDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the gutter decorations positions for it
const gutterLaxDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the gutter decorations positions for it
const gutterFlyCheckDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// Diagnostics raised by the server for each document
const diagnosticsMap : Map<string, vscode.Diagnostic[]> = new Map<string, vscode.Diagnostic[]>();
const diagnosticCollection = vscode.languages.createDiagnosticCollection('fstar-vscode-assistant');

// A background color for text being verified: Not currently used
const inProgressBackground = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(100, 0, 255, 0.5)'
});

// A map from file URI to the background color ranges for it
const proofInProgressDecorationMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// Messags in the small protocol running on top of LSP between the server and client
type ok_kind = 'checked' | 'light-checked' | 'flychecked';
interface StatusOkMessage {
	uri: string;
	ok_kind: ok_kind;
	ranges: vscode.Range [];
}

interface StatusFailedMessage {
	uri: string;
	ranges: vscode.Range [];
}

interface StatusClearMessage {
	uri: string;
}

interface StatusStartedMessage {
	uri: string;
	ranges: vscode.Range [];
}

interface AlertMessage {
	uri: string;
	message: string;
}

interface DiagnosticsMessage {
	uri: string;
	diagnostics: vscode.Diagnostic [];
}

interface ClearDiagnosticsMessage {
	uri: string;
}

// This function is called when the active editor changes or when a status message is received
// We set the gutter decorations for the document in the new active editor
// if the URI matches the URI of the document in the new active editor
function setActiveEditorDecorationsIfUriMatches(uri: string) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {	return; }
	if (editor.document.uri.toString() === uri) {
		const currentDecorations = gutterOkDecorationsMap.get(uri) ?? [];
		if (fstarVSCodeAssistantSettings.showFlyCheckIcon) {
			editor.setDecorations(gutterIconEye, gutterFlyCheckDecorationsMap.get(uri) ?? []);
		}
		editor.setDecorations(gutterIconOk, currentDecorations);
		if (fstarVSCodeAssistantSettings.showLightCheckIcon) {
			editor.setDecorations(gutterIconLax, gutterLaxDecorationsMap.get(uri) ?? []);
		}
		// Here's how you would set a background color for a region of text
		// editor.setDecorations(inProgressBackground, backgroundColorDecorationMap.get(uri) ?? []);
		editor.setDecorations(gutterIconHourglass, proofInProgressDecorationMap.get(uri) ?? []);
	}
}

// This function is called when the server sends a statusOk message
// We add the ranges to the map of gutter decorations for the file
// clearing any hourglass decorations
// and set the decorations for the active editor if the URI matches
function handleStatusOk (msg : StatusOkMessage)  {
	if (msg.ok_kind == "light-checked") {
		const currentDecorations : vscode.Range [] = gutterLaxDecorationsMap.get(msg.uri) ?? [];
		msg.ranges.forEach (range => {
			currentDecorations.push(range);
		});
		gutterLaxDecorationsMap.set(msg.uri, currentDecorations);	
	}
	else if (msg.ok_kind == "flychecked") {
		const currentDecorations : vscode.Range [] = gutterFlyCheckDecorationsMap.get(msg.uri) ?? [];
		msg.ranges.forEach (range => {
			currentDecorations.push(range);
		});
		gutterFlyCheckDecorationsMap.set(msg.uri, currentDecorations);
	}
	else {
		const currentDecorations : vscode.Range [] = gutterOkDecorationsMap.get(msg.uri) ?? [];
		msg.ranges.forEach (range => {
			currentDecorations.push(range);
		});
		gutterOkDecorationsMap.set(msg.uri, currentDecorations);
	}
	// clear hourglasses
	proofInProgressDecorationMap.set(msg.uri, []);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// This function is called when the server decideds that a chunk has failed verification
// Clear any hourglass decorations
function handleStatusFailed (msg : StatusFailedMessage)  {
	proofInProgressDecorationMap.set(msg.uri, []);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// This function is called when the server sends a statusStarted message
// We record the ranges in the proofInProgressDecorationMap
// and display the hourglass on those lines
function handleStatusStarted (msg: StatusStartedMessage): void {
	// console.log("Received statusClear notification: " +msg);
	proofInProgressDecorationMap.set(msg.uri, msg.ranges);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// This function is called when the server sends a statusClear message
// We clear the gutter decorations for the file
function handleStatusClear (msg: StatusClearMessage): void {
	// console.log("Received statusClear notification: " +msg);
	gutterOkDecorationsMap.set(msg.uri, []);
	gutterLaxDecorationsMap.set(msg.uri, []);
	gutterFlyCheckDecorationsMap.set(msg.uri, []);
	diagnosticsMap.set(msg.uri, []);
	const uri = vscode.Uri.parse(msg.uri);
	diagnosticCollection.set(uri, []);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// This function is called by the server in case F* crashed or was killed
function handleAlert(msg: AlertMessage) {
	vscode.window.showErrorMessage(msg.message + "\n On document: " + msg.uri);
}

function handleDiagnostics(msg: DiagnosticsMessage) {
	const docDiagnostics = diagnosticsMap.get(msg.uri) ?? [];
	function docContainsDiagnostic(diag: vscode.Diagnostic) {
		return docDiagnostics.some(d => d.range.isEqual(diag.range) && d.message === diag.message);
	}
	// De-duplicate diagnostics, because we may get diagnostics from multiple sources
	// both the fstar_ide and fstar_lax_ide servers may send diagnostics
	msg.diagnostics.forEach(diag => {
		if (!docContainsDiagnostic(diag)) {
			docDiagnostics.push(diag);
		}
	});
	diagnosticsMap.set(msg.uri, docDiagnostics);
	const uri = vscode.Uri.parse(msg.uri);
	diagnosticCollection.set(uri, docDiagnostics);
}

function handleClearDiagnostics(msg : ClearDiagnosticsMessage) {
	diagnosticsMap.set(msg.uri, []);
	const uri = vscode.Uri.parse(msg.uri);
	diagnosticCollection.set(uri, []);
}

// A client-only handler for a active editor changed raised by the editor
// We set the gutter decorations for the document in the new active editor
function handleDidChangeActiveEditor(editor : vscode.TextEditor) {
	// console.log("Active editor changed to " + editor.document.uri.toString());
	setActiveEditorDecorationsIfUriMatches(editor.document.uri.toString());
}

export function activate(context: ExtensionContext) {
	// The server is implemented in node
	const serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
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
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'fstar-vscode-assistant',
		'F* VSCode Assistant',
		serverOptions,
		clientOptions
	);
	
	client.onReady().then(() => {
		client.onNotification('fstar-vscode-assistant/statusOk', handleStatusOk);
		client.onNotification('fstar-vscode-assistant/statusClear', handleStatusClear);
		client.onNotification('fstar-vscode-assistant/statusStarted', handleStatusStarted);
		client.onNotification('fstar-vscode-assistant/statusFailed', handleStatusFailed);
		client.onNotification('fstar-vscode-assistant/alert', handleAlert);
		client.onNotification('fstar-vscode-assistant/diagnostics', handleDiagnostics);
		client.onNotification('fstar-vscode-assistant/clearDiagnostics', handleClearDiagnostics);
	});
	vscode.window.onDidChangeActiveTextEditor(handleDidChangeActiveEditor);

	// register a command for Ctrl+.
	const verifyCommand = vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/verify-to-position', (textEditor, edit) => {
		// console.log('Client: Command <verify-to-position> executed with uri: ' + textEditor.document.uri + " at positon " + textEditor.selection.active.line + ", " + textEditor.selection.active.character);
		client.sendRequest('fstar-vscode-assistant/verify-to-position', [textEditor.document.uri.toString(), textEditor.selection.active]);
	});
	context.subscriptions.push(verifyCommand);

	// register a command for Ctrl+;,Ctrl+.
	const reloadAndVerifyCommand = vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/restart', (textEditor, edit) => {
		// console.log('Client: Command <restart> executed with uri: ' + textEditor.document.uri);
		client.sendRequest('fstar-vscode-assistant/restart', textEditor.document.uri.toString());
	});
	context.subscriptions.push(reloadAndVerifyCommand);

	// register a command for Ctrl+Shift+.
	const laxVerifyCommand = vscode.commands.registerTextEditorCommand('fstar-vscode-assistant/lax-to-position', (textEditor, edit) => {
		// console.log('Client: Command <lax-to-position> executed with uri: ' + textEditor.document.uri + " at positon " + textEditor.selection.active.line + ", " + textEditor.selection.active.character);
		client.sendRequest('fstar-vscode-assistant/lax-to-position', [textEditor.document.uri.toString(), textEditor.selection.active]);
	});
	context.subscriptions.push(verifyCommand);
	
	// console.log("Activate called on " + context.asAbsolutePath("/"));

	workspace.onDidChangeTextDocument((event) => {
		// console.log("OnDidChangeTextDocument");
		const textDoc = event.document;
		let minRange : vscode.Range;
		function compareRange (a : vscode.Range, b : vscode.Range) : number {
			if (!a) { return -1; }
			if (!b) { return 1; }
			if (a.start.line < b.start.line) return -1;
			if (a.start.line > b.start.line) return 1;
			if (a.start.character < b.start.character) return -1;
			if (a.start.character > b.start.character) return 1;
			return 0;
		}
		event.contentChanges.forEach((change) => {
			if (compareRange(minRange, change.range) < 0) {
				minRange = change.range;
			}
		});
		if (minRange) {
			client.sendRequest('fstar-vscode-assistant/text-doc-changed', [textDoc.uri.toString(), minRange]);
		}
	});

	workspace.onDidChangeConfiguration((event) => {
		const cfg = workspace.getConfiguration('fstarVSCodeAssistant');
		fstarVSCodeAssistantSettings = {
			verifyOnOpen: cfg.get('verifyOnOpen', fstarVSCodeAssistantSettings.verifyOnOpen),
			verifyOnSave: cfg.get('verifyOnSave', fstarVSCodeAssistantSettings.verifyOnSave),
			flyCheck: cfg.get('flyCheck', fstarVSCodeAssistantSettings.flyCheck),
			debug: cfg.get('debug', fstarVSCodeAssistantSettings.debug),
			showFlyCheckIcon: cfg.get('showFlyCheckIcon', fstarVSCodeAssistantSettings.showFlyCheckIcon),
			showLightCheckIcon: cfg.get('showLightCheckIcon', fstarVSCodeAssistantSettings.showLightCheckIcon),
		};
	});

	// Start the client. This will also launch the server
	context.subscriptions.push(client.start());

}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
