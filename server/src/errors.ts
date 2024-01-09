class FStarError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FStarError";
	}
}

class UnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsupportedError";
	}
}
