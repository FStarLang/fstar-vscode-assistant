import { beforeEach, describe, expect, test, jest } from '@jest/globals';

import { JsonlInterface } from '../src/fstar';


describe('bufferedMessageHandler tests', () => {
	// The function we'll be testing, reset before each test
	let bufferedMessageHandler: (msg: string) => void;
	const mockHandler = jest.fn();

	beforeEach(() => {
		jest.clearAllMocks();

		// Reset the function we're testing, this will create a fresh buffer.
		const iface = new JsonlInterface(mockHandler, () => {});
		bufferedMessageHandler = msg => iface.onChunkReceived(msg);
	});

	test('test valid message', () => {
		const valid_message = '{"kind": "message"}\n';

		bufferedMessageHandler(valid_message);
		// Valid messages are passed on for further handling
		expect(mockHandler).toHaveBeenCalledTimes(1);
		expect(mockHandler).toHaveBeenLastCalledWith(JSON.parse(valid_message));
	});

	test('test fragmented message', () => {
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}\n';

		// Fragments are buffered until a full valid message is received, then it is
		// passed on for further handling.
		bufferedMessageHandler(fragment_0);
		expect(mockHandler).toHaveBeenCalledTimes(0);
		bufferedMessageHandler(fragment_1);
		expect(mockHandler).toHaveBeenCalledTimes(0);
		bufferedMessageHandler(fragment_2);
		expect(mockHandler).toHaveBeenCalledTimes(1);
		expect(mockHandler).toHaveBeenLastCalledWith(JSON.parse(fragment_0 + fragment_1 + fragment_2));
	});

	test('test valid messages flush buffer', () => {
		const valid_message = '{"kind": "message"}\n';
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}\n';

		// Fragments are assumed to be received in-order and before other
		// messages, so a valid message results in the buffer being flushed.
		bufferedMessageHandler(valid_message);
		expect(mockHandler).toHaveBeenCalledTimes(1);
		expect(mockHandler).toHaveBeenLastCalledWith(JSON.parse(valid_message));

		bufferedMessageHandler(valid_message);
		expect(mockHandler).toHaveBeenCalledTimes(2);
		expect(mockHandler).toHaveBeenLastCalledWith(JSON.parse(valid_message));

		bufferedMessageHandler(fragment_0);
		expect(mockHandler).toHaveBeenCalledTimes(2);
		bufferedMessageHandler(fragment_1);
		expect(mockHandler).toHaveBeenCalledTimes(2);
		bufferedMessageHandler(fragment_2);
		expect(mockHandler).toHaveBeenCalledTimes(3);

	});

	test('test combined messages and fragments processed separately', () => {
		const valid_message = '{"kind": "message"}\n';
		const fragment_0 = '{"kind": "';
		const fragment_1 = 'message';
		const fragment_2 = '"}\n';

		const combined_messages = [valid_message, fragment_0, fragment_1, fragment_2].join('');

		// Messages that are separated by newlines should be processed just as
		// if they were received as separate messages.
		bufferedMessageHandler(combined_messages);
		expect(mockHandler).toHaveBeenCalledTimes(2);
		expect(mockHandler).toHaveBeenNthCalledWith(1, JSON.parse(valid_message));
		expect(mockHandler).toHaveBeenNthCalledWith(2, JSON.parse(fragment_0 + fragment_1 + fragment_2));
	});
});
