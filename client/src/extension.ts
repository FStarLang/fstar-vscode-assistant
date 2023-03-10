/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import * as path from 'path';
import { workspace, ExtensionContext } from 'vscode';
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

// A map from file URI to the gutter decorations positions for it
const gutterOkDecorationsMap : Map<string, vscode.Range[]> = new Map<string, vscode.Range[]>();

// Messags in the small protocol running on top of LSP between the server and client
interface StatusOkMessage {
	uri: string;
	ranges: vscode.Range [];
}

interface StatusClearMessage {
	uri: string;
}

function setActiveEditorDecorationsIfUriMatches(uri: string) {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {	return; }
	if (editor.document.uri.toString() === uri) {
		const currentDecorations = gutterOkDecorationsMap.get(uri) ?? [];
		editor.setDecorations(gutterIconOk, currentDecorations);
	}
}

function handleStatusOk (msg : StatusOkMessage)  {
	console.log("Received statusOk notification: " +msg);
	const currentDecorations : vscode.Range [] = gutterOkDecorationsMap.get(msg.uri) ?? [];
	msg.ranges.forEach (range => {
		currentDecorations.push(range);
	});
	gutterOkDecorationsMap.set(msg.uri, currentDecorations);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

function handleStatusClear (msg: StatusClearMessage): void {
	console.log("Received statusClear notification: " +msg);
	const currentDecorations : vscode.Range [] = gutterOkDecorationsMap.get(msg.uri) ?? [];
	currentDecorations.length = 0;
	gutterOkDecorationsMap.set(msg.uri, currentDecorations);
	setActiveEditorDecorationsIfUriMatches(msg.uri);
}

// A client-only handler for a active editor changed raised by the editor
// We set the gutter decorations for the document in the new active editor
function handleDidChangeActiveEditor(editor : vscode.TextEditor) {
	console.log("Active editor changed to " + editor.document.uri.toString());
	const currentDecorations = gutterOkDecorationsMap.get(editor.document.uri.toString()) ?? [];
	editor.setDecorations(gutterIconOk, currentDecorations);
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
	});
	vscode.window.onDidChangeActiveTextEditor(handleDidChangeActiveEditor);

	console.log("Activate called on " + context.asAbsolutePath("/"));
	// Start the client. This will also launch the server
	context.subscriptions.push(client.start());

}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
