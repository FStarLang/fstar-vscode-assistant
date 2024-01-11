import {
	WorkspaceFolder,
} from 'vscode-languageserver/node';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';
import * as pstree from 'ps-tree';
import * as which from 'which';
import * as fs from 'fs';
import path = require('path');
import * as util from 'util';

import { fstarVSCodeAssistantSettings } from './settings';
import { ClientConnection } from './client_connection';
import { checkFileInDirectory, findFilesByExtension, getEnclosingDirectories } from './utils';

// FStar executable
export class FStar {
	proc: cp.ChildProcess;
	config: FStarConfig;
	// TODO(klinvill): @nikswamy, this just indicates whether the F* executable supports sending a full buffer, right?
	supportsFullBuffer: boolean;
	lax: boolean;

	constructor(proc: cp.ChildProcess, config: FStarConfig, supportsFullBuffer: boolean, lax: boolean) {
		this.proc = proc;
		this.config = config;
		this.supportsFullBuffer = supportsFullBuffer;
		this.lax = lax;
	}

	// Tries to spawn an fstar.exe process using the given configuration and
	// `textDocument` file.
	static trySpawnFstar(config: FStarConfig, textDocument: TextDocument, configurationSettings: fstarVSCodeAssistantSettings, connection: ClientConnection, lax?: 'lax'): FStar | undefined {
		// F* is assumed to support full-buffers unless it sends a message indicating otherwise
		const supportsFullBuffer = true;

		// Construct the options for fstar.exe
		const filePath = URI.parse(textDocument.uri);
		const options = ["--ide", filePath.fsPath];

		if (lax) {
			// The lax process actually runs with admit_smt_queries
			options.push("--admit_smt_queries");
			options.push("true");
		}

		if (config.options) {
			config.options.forEach((opt) => { options.push(opt); });
		}
		if (config.include_dirs) {
			config.include_dirs.forEach((dir) => { options.push("--include"); options.push(dir); });
		}
		if (!config.fstar_exe) {
			config.fstar_exe = "fstar.exe";
		}
		if (!config.cwd) {
			config.cwd = path.dirname(filePath.fsPath);
		}
		if (configurationSettings.debug) {
			console.log("Spawning fstar with options: " + options);
		}

		// check if fstar_exe can be found in the current path
		// using which
		try {
			const fstar_exe_path = which.sync(config.fstar_exe);
		}
		catch (err) {
			connection.sendAlert({ message: "Failed to find fstar.exe in path: " + err, uri: textDocument.uri });
			return undefined;
		}

		const proc = cp.spawn(
			config.fstar_exe,
			options,
			{ cwd: config.cwd }
		);

		return new FStar(proc, config, supportsFullBuffer, !!lax);
	}

	// Dynamically loads the FStarConfiguration for a given file `textDocument`
	// before attempting to launch an instance of F*.
	static async fromInferredConfig(textDocument: TextDocument, workspaceFolders: WorkspaceFolder[], connection: ClientConnection,
			configurationSettings: fstarVSCodeAssistantSettings, lax?: 'lax'): Promise<FStar | undefined> {
		const config = await this.getFStarConfig(textDocument, workspaceFolders, connection, configurationSettings);
		return this.trySpawnFstar(config, textDocument, configurationSettings, connection, lax);
	}

	killZ3SubProcess(configurationSettings: fstarVSCodeAssistantSettings) {
		if (!this.proc || !this.proc.pid) { return; }
		pstree(this.proc.pid, (err, children) => {
			if (err) { return; }
			const z3Processes = children.filter(p => p.COMMAND.startsWith("z3"));
			z3Processes.forEach(p => {
				if (configurationSettings.debug) {
					console.log("Killing z3 process with PID: " + p.PID);
				}
				process.kill(parseInt(p.PID));
			});
		});
	}

	static async parseConfigFile(textDocument: TextDocument, configFile: string, connection: ClientConnection, configurationSettings: fstarVSCodeAssistantSettings): Promise<FStarConfig> {
		const contents = await util.promisify(fs.readFile)(configFile, 'utf8');
		function substituteEnvVars(value: string) {
			return value.replace(/\$([A-Z_]+[A-Z0-9_]*)|\${([A-Z0-9_]*)}/ig,
				(_, a, b) => {
					const resolved_env_var = a ? process.env[a] : process.env[b];
					if (resolved_env_var) {
						return resolved_env_var;
					}
					else {
						connection.sendAlert({ message: "Failed to resolve environment variable " + (a || b), uri: textDocument.uri });
						return "";
					}
				});
		}
		function substituteEnvVarsInValue(value: any): any {
			switch (typeof value) {
				case "string":
					return substituteEnvVars(value);
				case "object":
					if (Array.isArray(value)) {
						return value.map(substituteEnvVarsInValue);
					} else {
						const result: { [key: string]: any } = {};
						for (const [key, val] of Object.entries(value)) {
							result[key] = substituteEnvVarsInValue(val);
						}
						return result;
					}
				default:
					return value;
			}
		}
		const config = JSON.parse(contents, (key, value) => substituteEnvVarsInValue(value));
		if (configurationSettings.debug) {
			console.log("Parsed config file: " + JSON.stringify(config));
		}

		return config;
	}

	// Finds the .fst.config.json for a given file
	// by searching from that file's directory up to the workspace root
	// for a .fst.config.json file, taking the one nearest to the file
	static async findConfigFile(e: TextDocument, workspaceFolders: WorkspaceFolder[], configurationSettings: fstarVSCodeAssistantSettings): Promise<string | undefined> {
		const filePath = URI.parse(e.uri).fsPath;
		const allEnclosingDirectories = getEnclosingDirectories(filePath);
		for (const dir of allEnclosingDirectories) {
			if (configurationSettings.debug) {
				console.log("Checking directory " + dir + " for config file");
			}

			let dirInWorkspaceFolder = false;
			for (const folder of workspaceFolders) {
				dirInWorkspaceFolder ||= await checkFileInDirectory(URI.parse(folder.uri).fsPath, dir);
			}
			if (!dirInWorkspaceFolder) break;

			const matches = await findFilesByExtension(dir, '.fst.config.json');
			if (matches.length > 0) {
				if (configurationSettings.debug) {
					console.log("Using config file " + matches[0] + " for " + filePath);
				}
				return matches[0];
			}
		}
		return undefined;
	}

	// Either finds and loads the closest .fst.config.json for the given file, or returns a default configuration.
	static async getFStarConfig(textDocument: TextDocument, workspaceFolders: WorkspaceFolder[], connection: ClientConnection, configurationSettings: fstarVSCodeAssistantSettings): Promise<FStarConfig> {
		const filePath = URI.parse(textDocument.uri).fsPath;
		const defaultConfig: FStarConfig = {
			options: [],
			include_dirs: [],
			fstar_exe: "fstar.exe",
			cwd: path.dirname(filePath)
		};
		const configFilepath = await this.findConfigFile(textDocument, workspaceFolders, configurationSettings);

		let config;
		if (configFilepath) {
			config = await this.parseConfigFile(textDocument, configFilepath, connection, configurationSettings);

			// If cwd isn't specified, it's assumed to be the directory in which the
			// config file is located.
			if (config && !config.cwd) {
				config.cwd = path.dirname(configFilepath);
			}
		}
		return config || defaultConfig;
	}
}

// The type of an .fst.config.json file
interface FStarConfig {
	include_dirs?: string[]; // --include paths
	options?: string[];      // other options to be passed to fstar.exe
	fstar_exe?: string;       // path to fstar.exe
	cwd?: string;            // working directory for fstar.exe (usually not specified; defaults to workspace root)
}
