/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { CancellationToken, Command, CustomDocument, CustomDocumentOpenContext, CustomReadonlyEditorProvider, Uri, WebviewPanel } from 'vscode';
import * as cp from 'child_process';
import * as util from 'util';
import { escape } from 'html-escaper';

class CommandOutputDocument implements CustomDocument {
	constructor(public uri: Uri, public cmd: string, public stdout: string, public stderr: string) {}
	toHtml(): string {
		return `<html>
<head>
	<style>
	body {
		background: var(--vscode-editor-background);
		color: var(--vscode-editor-foreground);
	}
	pre, .code {
		font-family: var(--vscode-editor-font-family);
		font-size: var(--vscode-editor-font-size);
	}
	</style>
</head>
<body>
<p>Output of <span class="code">${escape(this.cmd)}</span>:</p>
<pre>
${escape(this.stdout)}
<div style="color: var(--vscode-errorForeground)">${escape(this.stderr)}</div>
</pre>
`;
	}
	dispose(): void {}
}

abstract class CommandOutputProvider implements CustomReadonlyEditorProvider<CommandOutputDocument> {
	async openCustomDocument(uri: Uri): Promise<CommandOutputDocument> {
		const cmd = this.getCommand(uri);
		const out = await util.promisify(cp.execFile)(cmd[0], cmd.slice(1), {
			maxBuffer: 50*1024*1024, // allow up to 50 megabytes of output
		});
		return new CommandOutputDocument(uri, cmd.join(' '), out.stdout, out.stderr);
	}
	resolveCustomEditor(document: CommandOutputDocument, webviewPanel: WebviewPanel) {
		webviewPanel.webview.html = document.toHtml();
	}
	abstract getCommand(uri: Uri): string[];
}

export class CheckedFileEditorProvider extends CommandOutputProvider {
	getCommand(uri: Uri): string[] { return ['fstar.exe', '--read_checked_file', uri.fsPath]; }
}
export class KrmlFileEditorProvider extends CommandOutputProvider {
	getCommand(uri: Uri): string[] { return ['fstar.exe', '--read_krml_file', uri.fsPath]; }
}