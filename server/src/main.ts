/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	TextDocuments
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import { ClientConnection } from './client_connection';
import { Server } from './server';

// Connection between the LSP server and client (e.g. the extension)
const connection = new ClientConnection();
// Simple text document manager.
const documents = new TextDocuments(TextDocument);

// Create and start the LSP server, everything else is launched off of this server.
const server = new Server(connection, documents);
server.run();
