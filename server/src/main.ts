/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	ProposedFeatures,
	TextDocuments,
	createConnection,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { Server } from './server';

// Make unhandled rejections non-fatal
process.on('unhandledRejection', error => console.log('Unhandled rejection:', error));

// Connection between the LSP server and client (e.g. the extension)
const connection = createConnection(ProposedFeatures.all);
// Simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create and start the LSP server, everything else is launched off of this server.
const server = new Server(connection, documents);
server.run();
