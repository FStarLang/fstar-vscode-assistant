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
		'languageServerExample',
		'Language Server Example',
		serverOptions,
		clientOptions
	);

	// const serverOptions : ServerOptions = {
	// 	run : {
	// 		command: "fstar.exe",
	// 		args: ["--lsp"]
	// 	},
	// 	debug : {
	// 		command: "fstar.exe",
	// 		args: ["--lsp"]
	// 	}
	// };

	// // // Create the language client and start the client.
	// client = new LanguageClient(
	// 	'languageServerExample',
	// 	'Language Server Example',
	// 	serverOptions,
	// 	{ documentSelector: [{ scheme: "file", language: "fstar" }] },
	// 	true
	// );
	const gutterIconOk =vscode.window.createTextEditorDecorationType(
		{
			gutterIconSize: 'contain',
			gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'check.svg')
		});
	
	// const gutterIconDecorationOk : vscode.TextEditorDecorationType = {
	// 	gutterIconSize: 'contain',
	// 	gutterIconPath: path.join(__filename, '..', '..', '..', 'resources',  'icons', 'check.svg')
	// };
	let currentDecorations : vscode.Range [] = [];

	client.onReady().then(() => {
		client.onNotification('custom/statusOk', (args: Array<number>) => {
			console.log("Received statusOk notification: " +args);
			if (!vscode.window.activeTextEditor) {
				console.log("No active text editor");
			}
			else {
				console.log("Setting decoration");
				const start_pos = new vscode.Position(args[0], args[1]);
				const end_pos = new vscode.Position(args[2], args[3]);
				currentDecorations.push(new vscode.Range(start_pos, end_pos));
				vscode.window.activeTextEditor?.setDecorations(gutterIconOk, currentDecorations);
			}
		});

		client.onNotification('custom/statusClear', (args:Array<string>) => {
			currentDecorations = [];
			vscode.window.activeTextEditor?.setDecorations(gutterIconOk, []);
		});
	});
	vscode.window.onDidChangeActiveTextEditor((editor) => {
		return;// do something with the new active editor
	});
	console.log("Activate called on " + context.asAbsolutePath("/"));
	// Start the client. This will also launch the server
	context.subscriptions.push(client.start());

	// console.log("Activate called on " + context.asAbsolutePath("/"));
	
	// // Start the client. This will also launch the server
	// client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
