export class FStarError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FStarError";
	}
}

export class UnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedError";
	}
}
