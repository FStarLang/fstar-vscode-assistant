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

// A map from file URI to the gutter decorations positions for it
const gutterOkDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A map from file URI to the gutter decorations positions for it
const gutterLaxDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// A background color for text being verified: Not currently used
const inProgressBackground = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(100, 0, 255, 0.5)'
});

// A map from file URI to the background color ranges for it
const proofInProgressDecorationMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// Messags in the small protocol running on top of LSP between the server and client
interface StatusOkMessage {
	uri: string;
	lax: boolean;
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

// This function is called when the active editor changes or when a status message is received
// We set the gutter decorations for the document in the new active editor
// if the URI matches the URI of the document in the new active editor
function setActiveEditorDecorationsIfUriMatches(uri: string) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {	return; }
	if (editor.document.uri.toString() === uri) {
		const currentDecorations = gutterOkDecorationsMap.get(uri) ?? [];
		editor.setDecorations(gutterIconOk, currentDecorations);
		editor.setDecorations(gutterIconLax, gutterLaxDecorationsMap.get(uri) ?? []);
		// editor.setDecorations(inProgressBackground, backgroundColorDecorationMap.get(uri) ?? []);
		editor.setDecorations(gutterIconHourglass, proofInProgressDecorationMap.get(uri) ?? []);
	}
}

// This function is called when the server sends a statusOk message
// We add the ranges to the map of gutter decorations for the file
// clearing any hourglass decorations
// and set the decorations for the active editor if the URI matches
function handleStatusOk (msg : StatusOkMessage)  {
	if (msg.lax) {
		const currentDecorations : vscode.Range [] = gutterLaxDecorationsMap.get(msg.uri) ?? [];
		msg.ranges.forEach (range => {
			currentDecorations.push(range);
		});
		gutterLaxDecorationsMap.set(msg.uri, currentDecorations);
	
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
	console.log("Received statusClear notification: " +msg);
	proofInProgressDecorationMap.set(msg.uri, msg.ranges);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// This function is called when the server sends a statusClear message
// We clear the gutter decorations for the file
function handleStatusClear (msg: StatusClearMessage): void {
	console.log("Received statusClear notification: " +msg);
	const currentDecorations : vscode.Range [] = gutterOkDecorationsMap.get(msg.uri) ?? [];
	currentDecorations.length = 0;
	gutterOkDecorationsMap.set(msg.uri, currentDecorations);
	const currentLaxDecorations : vscode.Range [] = gutterLaxDecorationsMap.get(msg.uri) ?? [];
	currentLaxDecorations.length = 0;
	gutterLaxDecorationsMap.set(msg.uri, currentLaxDecorations);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// A client-only handler for a active editor changed raised by the editor
// We set the gutter decorations for the document in the new active editor
function handleDidChangeActiveEditor(editor : vscode.TextEditor) {
	console.log("Active editor changed to " + editor.document.uri.toString());
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
		client.onNotification('custom/statusOk', handleStatusOk);
		client.onNotification('custom/statusClear', handleStatusClear);
		client.onNotification('custom/statusStarted', handleStatusStarted);
		client.onNotification('custom/statusFailed', handleStatusFailed);
	});
	vscode.window.onDidChangeActiveTextEditor(handleDidChangeActiveEditor);

	// register a command for Ctrl+.
	const verifyCommand = vscode.commands.registerTextEditorCommand('fstar-extension/verify-to-position', (textEditor, edit) => {
		console.log('Client: Command <verify-to-position> executed with uri: ' + textEditor.document.uri + " at positon " + textEditor.selection.active.line + ", " + textEditor.selection.active.character);
		client.sendRequest('fstar-extension/verify-to-position', [textEditor.document.uri.toString(), textEditor.selection.active]);
	});
	context.subscriptions.push(verifyCommand);

	// register a command for Ctrl+;,Ctrl+.
	const reloadAndVerifyCommand = vscode.commands.registerTextEditorCommand('fstar-extension/reload-deps-and-verify', (textEditor, edit) => {
		console.log('Client: Command <reload-deps-and-verify> executed with uri: ' + textEditor.document.uri);
		client.sendRequest('fstar-extension/reload-deps-and-verify', textEditor.document.uri.toString());
	});

	// register a command for Ctrl+Shift+.
	const laxVerifyCommand = vscode.commands.registerTextEditorCommand('fstar-extension/lax-to-position', (textEditor, edit) => {
		console.log('Client: Command <lax-to-position> executed with uri: ' + textEditor.document.uri + " at positon " + textEditor.selection.active.line + ", " + textEditor.selection.active.character);
		client.sendRequest('fstar-extension/lax-to-position', [textEditor.document.uri.toString(), textEditor.selection.active]);
	});
	context.subscriptions.push(verifyCommand);
	
	console.log("Activate called on " + context.asAbsolutePath("/"));

	workspace.onDidChangeTextDocument((event) => {
		console.log("OnDidChangeTextDocument");
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
			client.sendRequest('fstar-extension/text-doc-changed', [textDoc.uri.toString(), minRange]);
		}
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
