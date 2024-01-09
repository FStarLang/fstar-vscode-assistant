/// Basic Result type similar to Rust
export type Result<T, E extends Error> = Ok<T> | E;

export class Ok<T> {
	value: T;
	constructor(value: T) {
		this.value = value;
	}
}
