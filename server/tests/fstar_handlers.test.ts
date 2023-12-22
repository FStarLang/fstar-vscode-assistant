import { beforeEach, describe, expect, test, jest } from '@jest/globals';

import * as fstar_handlers from '../src/fstar_handlers';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { defaultSettings } from '../src/settings';

// Mocks
import { Server } from '../src/server';
jest.mock('../src/server');
import { ClientConnection } from '../src/client_connection';
jest.mock('../src/client_connection');


// Mocked objects to use in this test suite
//
// Note: jest.mocked() ensures that the mock is type-safe. See
// https://jestjs.io/docs/mock-function-api#jestmockedsource-options for more
// details.
const mockConnection = new (jest.mocked(ClientConnection))();
const mockServer = new (jest.mocked(Server))(mockConnection, new TextDocuments(TextDocument));

beforeEach(() => {
	jest.clearAllMocks();
});

describe('handleFStarResponseForDocument tests', () => {
	// `handleFStarResponseForDocument` calls `handleOneResponseForDocument`. We
	// therefore mock `handleOneResponseForDocument` out to simplify these
	// tests. The factory function is mocked to just return the mocked
	// `handleOneResponseForDocument` function.
	const handleOneResponseForDocumentMock = jest.fn();
	const _ = jest.spyOn(fstar_handlers, 'handleOneResponseForDocumentFactory').mockReturnValue(handleOneResponseForDocumentMock);

	// The function we'll be testing, complete with mocked dependencies
	const handleFStarResponseForDocument = fstar_handlers.handleFStarResponseForDocumentFactory(defaultSettings, mockServer, mockConnection);

	// Common test parameters
	const td = TextDocument.create("test", "test", 0, "test");
	const lax = false;

	test('test valid message', () => {
		const valid_message = '{"kind": "message"}';

		handleFStarResponseForDocument(td, valid_message, lax);
		// Valid messages are passed on for further handling
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(1);
		expect(handleOneResponseForDocumentMock).toHaveBeenLastCalledWith(td, valid_message, lax);
	});

	test('test fragmented message', () => {
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}';

		// Fragments are buffered until a full valid message is received, then it is
		// passed on for further handling.
		handleFStarResponseForDocument(td, fragment_0, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(0);
		handleFStarResponseForDocument(td, fragment_1, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(0);
		handleFStarResponseForDocument(td, fragment_2, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(1);
		expect(handleOneResponseForDocumentMock).toHaveBeenLastCalledWith(td, fragment_0 + fragment_1 + fragment_2, lax);
	});

	test('test out-of-order fragmented messages are not handled', () => {
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}';

		// Fragments are assumed to be received in-order, so out-of-order
		// fragments have undefined behavior. In this test case, no valid
		// message can be collected.
		handleFStarResponseForDocument(td, fragment_2, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(0);
		handleFStarResponseForDocument(td, fragment_1, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(0);
		handleFStarResponseForDocument(td, fragment_0, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(0);
	});

	test('test valid messages flush buffer', () => {
		const valid_message = '{"kind": "message"}';
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}';

		// Fragments are assumed to be received in-order and before other
		// messages, so a valid message results in the buffer being flushed.
		handleFStarResponseForDocument(td, valid_message, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(1);
		expect(handleOneResponseForDocumentMock).toHaveBeenLastCalledWith(td, valid_message, lax);

		handleFStarResponseForDocument(td, fragment_0, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(1);

		handleFStarResponseForDocument(td, valid_message, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(2);
		expect(handleOneResponseForDocumentMock).toHaveBeenLastCalledWith(td, valid_message, lax);

		handleFStarResponseForDocument(td, fragment_1, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(2);
		handleFStarResponseForDocument(td, fragment_2, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(2);

	});

	test('test combined messages and fragments processed separately', () => {
		const valid_message = '{"kind": "message"}';
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}';

		const combined_messages = [valid_message, fragment_0, fragment_1, fragment_2].join('\n');

		// Messages that are separated by newlines should be processed just as
		// if they were received as separate messages.
		handleFStarResponseForDocument(td, combined_messages, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenCalledTimes(2);
		expect(handleOneResponseForDocumentMock).toHaveBeenNthCalledWith(1, td, valid_message, lax);
		expect(handleOneResponseForDocumentMock).toHaveBeenNthCalledWith(2, td, fragment_0 + fragment_1 + fragment_2, lax);
	});
});
