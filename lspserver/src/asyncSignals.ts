export interface AsyncSignalProc {
	fire(k: () => Promise<void>): void;
	settled: Promise<void>
}

/**
Rate-limits a signal to an interval of `millis` milliseconds.

```
Input:   AB   C D E   F
Output:  AAAA CCC  EEEEEEFFFF
```

- A handler is called at most once every `millis` milliseconds.
- Handlers are never called concurrently.
*/
export class AsyncRateLimiter implements AsyncSignalProc {
	constructor(public millis: number) {}

	private missedFire?: () => Promise<void>;
	private running = false;
	private fireSettled: () => void = () => {};
	settled: Promise<void> = Promise.resolve();

	fire(k: () => Promise<void>) {
		if (this.running) {
			if (!this.missedFire) {
				this.settled = new Promise(resolved => this.fireSettled = resolved);
			}
			this.missedFire = k;
		} else {
			this.running = true;
			this.settled = new Promise(resolved => this.fireSettled = resolved);
			this.go(k);
		}
	}

	private go(k: () => Promise<void>) {
		const timeout = new Promise(resolve => setTimeout(resolve, this.millis));
		void k().catch(() => {}).then(this.fireSettled).then(() => timeout).then(() => {
			if (this.missedFire) {
				this.go(this.missedFire);
				this.missedFire = undefined;
			} else {
				this.running = false;
			}
		});
	}
}