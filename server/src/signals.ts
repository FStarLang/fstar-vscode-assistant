/**
Generic interface for a signal processor.

Input signals are received by calling `fire()`.
The transformed output signal is sent via the `handler()` callback (which is set by the user).
*/
export interface SignalProc {
	fire(): void;
	handler: () => void;
}

/**
Debounces a signal with a settling time of `millis` milliseconds.

```
Input:   xx  x x x   x
Output:                   x
```

- The handler is called at most once every `millis` milliseconds.
- If an input is received, then the handler will be called after that, eventually.
- We wait `millis` milliseconds after the last input before calling the handler.
*/
export class Debouncer implements SignalProc {
	constructor(public millis: number, public handler = () => {}) {}

	private timeout?: NodeJS.Timeout;

	cancel() {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
	}

	fire() {
		this.cancel();
		this.timeout = setTimeout(() => {
			this.timeout = undefined;
			this.handler();
		}, this.millis);
	}
}

/**
Rate-limits a signal to an interval of `millis` milliseconds.

```
Input:   xx  x x x   x
Output:  x    x    x    x
```

- The handler is called at most once every `millis` milliseconds.
- If an input is received, then the handler will be called after at most `millis` milliseconds.
*/
export class RateLimiter implements SignalProc {
	constructor(public millis: number, public handler = () => {}) {}

	private missedFire = false;
	private timeout?: NodeJS.Timeout;

	fire() {
		if (this.timeout) {
			this.missedFire = true;
		} else {
			this.setTimeout();
			// Run async
			setTimeout(() => this.handler());
		}
	}

	private setTimeout() {
		this.timeout = setTimeout(() => {
			this.timeout = undefined;
			if (this.missedFire) {
				this.missedFire = false;
				this.setTimeout();
				this.handler();
			}
		}, this.millis);
	}
}