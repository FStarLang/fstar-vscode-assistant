import {
	Hover,
	Position,
	Range
} from 'vscode-languageserver/node';

import path = require('path');
import { pathToFileURL } from 'url';

import * as fs from 'fs';

import { Server } from './server';

////////////////////////////////////////////////////////////////////////////////////
// Range utilities
////////////////////////////////////////////////////////////////////////////////////
export function mkPosition(pos: number[]): Position {
	//F* line numbers begin at 1; unskew
	return Position.create(pos[0] > 0 ? pos[0] - 1 : pos[0], pos[1]);
}

export function fstarRangeAsRange(rng: FStarRange): Range {
	return Range.create(mkPosition(rng.beg), mkPosition(rng.end));
}

export function rangeAsFStarRange(rng: Range): FStarRange {
	return {
		fname: "<input>",
		beg: [rng.start.line + 1, rng.start.character],
		end: [rng.end.line + 1, rng.end.character]
	};
}

export function qualifyFilename(fname: string, textdocUri: string, server: Server): string {
	const doc_state = server.getDocumentState(textdocUri);
	if (fname != "<input>") {
		// if we have a relative path, then qualify it to the base of the
		// F* process's cwd
		if (!path.isAbsolute(fname) && doc_state && doc_state.fstar.config.cwd) {
			const base = doc_state.fstar.config.cwd;
			//concate the base and the relative path
			return pathToFileURL(path.join(base, fname)).toString();
		}
		else {
			return pathToFileURL(fname).toString();
		}
	}
	return textdocUri;
}


////////////////////////////////////////////////////////////////////////////////////
// PATH and URI Utilities
////////////////////////////////////////////////////////////////////////////////////

// Checks if filePath is includes in the cone rooted at dirPath
// Used to check if a file is in the workspace
export function checkFileInDirectory(dirPath: string, filePath: string): boolean {
	// Check if dirPath is a directory using fs.stat()
	const stats = fs.statSync(dirPath);
	if (!stats || !stats.isDirectory()) {
		//console.log(dirPath + ' is not a directory');
		return false;
	}

	// Get the relative path from dirPath to filePath using path.relative()
	const relativePath = path.relative(dirPath, filePath);
	// console.log("Relative path of " + filePath + " from " + dirPath + " is " + relativePath);
	// Check if relativePath starts with '..' or '.'
	if (relativePath.startsWith('..')) {
		// If yes, then filePath is outside dirPath
		return false;
	} else {
		// If yes, then filePath is inside dirPath
		return true;
	}
}


// Finds all files in a folder whose name has `extension` as a suffix
// Returns an array of absolute paths of the files
// Used to find all config files in the workspace
export function findFilesByExtension(folderPath: string, extension: string) {
	// Read the folder contents using fs.readdir()
	const matches: string[] = [];
	const files = fs.readdirSync(folderPath);
	if (!files) {
		console.error("No files found in " + folderPath);
		return [];
	}
	// Loop over the files
	for (const file of files) {
		// console.log("Checking file " + file + " for extension " + extension);
		if (file.endsWith(extension)) {
			// console.log("Found config file " + file);
			// absolute path of file is folderPath + file
			matches.push(path.join(folderPath, file));
		}
	}
	return matches;
}

export function getEnclosingDirectories(filePath: string): string[] {
	const result: string[] = [];
	let currentPath = filePath;
	while (currentPath !== path.dirname(currentPath)) {
		currentPath = path.dirname(currentPath);
		result.push(currentPath);
	}
	return result;
}


////////////////////////////////////////////////////////////////////////////////////
// Symbol table and proof state utilities
////////////////////////////////////////////////////////////////////////////////////

// Print a single ContextualGoal to show in a hover message
function formatProofStateContextualGoal(goal: IdeProofStateContextualGoal): string {
	let result = "";
	for (const hyp of goal.hyps) {
		result += hyp.name + " : " + hyp.type + "\n";
	}
	result += "------------------ " + goal.goal.witness + "\n";
	result += goal.goal.type;
	return result;
}

// Print an array of ContextualGoals to show in a hover message
function formatContextualGoalArray(goals: IdeProofStateContextualGoal[]): string {
	let result = "";
	let goal_ctr = 1;
	const n_goals = goals.length;
	goals.forEach((g) => {
		result += "Goal " + goal_ctr + " of " + n_goals + " :\n";
		result += "```fstar\n" + formatProofStateContextualGoal(g) + "\n```\n\n";
		goal_ctr++;
	});
	return result;
}

// Print the entire proof state to show in a hover message
export function formatIdeProofState(ps: IdeProofState): string {
	let result = "### Proof state \n";
	result += "(" + ps.label + ")\n";
	if (ps.goals && ps.goals.length > 0) {
		result += "**Goals**\n";
		result += formatContextualGoalArray(ps.goals);
	}
	if (ps["smt-goals"] && ps["smt-goals"].length > 0) {
		result += "**SMT Goals**\n";
		result += formatContextualGoalArray(ps["smt-goals"]);
	}
	return result;
}

// Print a single symbol entry to show in a hover message
export function formatIdeSymbol(symbol: IdeSymbol): Hover {
	return {
		contents: {
			kind: 'markdown',
			value: "```fstar\n" + symbol.name + ":\n" + symbol.type + "\n```\n"
		}
	};
}
