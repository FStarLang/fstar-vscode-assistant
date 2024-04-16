import {
	WorkspaceFolder,
} from 'vscode-languageserver/node';

import {
	URI
} from 'vscode-uri';

import * as cp from 'child_process';
import * as pstree from 'ps-tree';
import * as which from 'which';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';

import { fstarVSCodeAssistantSettings } from './settings';
import { ClientConnection } from './client_connection';
import { checkFileInDirectory, findFilesByExtension, getEnclosingDirectories } from './utils';

// FStar executable
export class FStar {
	proc: cp.ChildProcess;
	config: FStarConfig;
	// Indicates whether the F* process supports full-buffer mode
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
	//
	// @throws {Error} if fstar.exe cannot be found in the current path
	static trySpawnFstar(config: FStarConfig, filePath: string, debug: boolean, lax?: 'lax'): FStar | undefined {
		// F* is assumed to support full-buffers unless it sends a message indicating otherwise
		const supportsFullBuffer = true;

		// Construct the options for fstar.exe
		const options = ["--ide", filePath];

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
			config.cwd = path.dirname(filePath);
		}
		if (debug) {
			console.log("Spawning fstar with options: " + options);
		}

		// check if fstar_exe can be found in the current path
		// using which
		try {
			which.sync(config.fstar_exe);
		}
		catch (err) {
			throw new Error("Failed to find fstar.exe in path: " + err);
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
	static async fromInferredConfig(filePath: string, workspaceFolders: WorkspaceFolder[], connection: ClientConnection,
			configurationSettings: fstarVSCodeAssistantSettings, lax?: 'lax'): Promise<FStar | undefined> {
		const config = await this.getFStarConfig(filePath, workspaceFolders, connection, configurationSettings);
		return this.trySpawnFstar(config, filePath, configurationSettings.debug, lax);
	}

	killZ3SubProcess(debug: boolean) {
		if (!this.proc || !this.proc.pid) { return; }
		pstree(this.proc.pid, (err, children) => {
			if (err) { return; }
			const z3Processes = children.filter(p => p.COMMAND.startsWith("z3"));
			z3Processes.forEach(p => {
				if (debug) {
					console.log("Killing z3 process with PID: " + p.PID);
				}
				process.kill(parseInt(p.PID));
			});
		});
	}

	static async parseConfigFile(filePath: string, configFile: string, connection: ClientConnection, configurationSettings: fstarVSCodeAssistantSettings): Promise<FStarConfig> {
		const contents = await util.promisify(fs.readFile)(configFile, 'utf8');
		function substituteEnvVars(value: string) {
			return value.replace(/\$([A-Z_]+[A-Z0-9_]*)|\${([A-Z0-9_]*)}/ig,
				(_, a, b) => {
					const resolved_env_var = a ? process.env[a] : process.env[b];
					if (resolved_env_var) {
						return resolved_env_var;
					}
					else {
						connection.sendAlert({ message: "Failed to resolve environment variable " + (a || b), uri: URI.file(filePath).toString() });
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
	static async findConfigFile(filePath: string, workspaceFolders: WorkspaceFolder[], configurationSettings: fstarVSCodeAssistantSettings): Promise<string | undefined> {
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

	static async getConfigFromMakefile(filePath: string): Promise<FStarConfig | undefined> {
		const cwd = path.dirname(filePath);
		let out: {stdout: string, stderr: string};
		try {
			out = await util.promisify(cp.execFile)('make', [`${path.basename(filePath)}-in`], {cwd});
		} catch (e) {
			return;
		}
		const cmdlineOpts = out.stdout.trim().split(' ');

		const options: string[] = [];
		const include_dirs: string[] = [];

		// Separate cmdlineOpts into options and include_dirs
		let nextIsInclude = false;
		for (const opt of cmdlineOpts) {
			if (nextIsInclude) {
				include_dirs.push(opt);
				nextIsInclude = false;
			} else if (opt === '--include') {
				nextIsInclude = true;
			} else {
				options.push(opt);
			}
		}

		return { cwd, include_dirs, options };
	}

	// Loads the F* configuration from the first available source:
	// 1. An *.fst.config.json file in a parent directory inside the current workspace
	// 2. The output printed by `make My.File.fst-in`
	// 3. A default configuration
	static async getFStarConfig(filePath: string, workspaceFolders: WorkspaceFolder[], connection: ClientConnection, configurationSettings: fstarVSCodeAssistantSettings): Promise<FStarConfig> {
		// 1. Config file
		const configFilepath = await this.findConfigFile(filePath, workspaceFolders, configurationSettings);
		if (configFilepath) {
			const config = await this.parseConfigFile(filePath, configFilepath, connection, configurationSettings);
			if (config) {
				// If cwd isn't specified, it's assumed to be the directory in which the
				// config file is located.
				config.cwd ??= path.dirname(configFilepath);
				return config;
			}
		}

		// 2. Makefile
		const configFromMakefile = await this.getConfigFromMakefile(filePath);
		if (configFromMakefile) return configFromMakefile;

		// 3. Default
		return {
			options: [],
			include_dirs: [],
			fstar_exe: "fstar.exe",
			cwd: path.dirname(filePath)
		};
	}
}

// The type of an .fst.config.json file
export interface FStarConfig {
	include_dirs?: string[]; // --include paths
	options?: string[];      // other options to be passed to fstar.exe
	fstar_exe?: string;       // path to fstar.exe
	cwd?: string;            // working directory for fstar.exe (usually not specified; defaults to workspace root)
}
