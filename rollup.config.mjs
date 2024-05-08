import { defineConfig } from 'rollup';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import nodeResolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';

const terserPlugin =
	terser({
		mangle: {
			keep_classnames: true,
			keep_fnames: true,
		},
		compress: {
			defaults: false,
		},
		format: {
			beautify: true,
		},
	});

export default defineConfig([
	{
		input: 'client/src/extension.ts',
		output: {
			file: 'client/out/extension.js',
			format: 'cjs',
			sourcemap: true,
		},
		external: ['vscode'],
		plugins: [
			commonjs({
				strictRequires: true,
			}),
			nodeResolve(),
			typescript({'tsconfig': 'client/tsconfig.json', 'module': 'esnext'}),
			terserPlugin,
		],
	},
	{
		input: 'server/src/main.ts',
		output: {
			file: 'server/out/main.js',
			format: 'cjs',
			sourcemap: true,
		},
		plugins: [
			commonjs(),
			nodeResolve({preferBuiltins: true}),
			typescript({'tsconfig': 'server/tsconfig.json', 'module': 'esnext'}),
			terserPlugin,
		],
	},
]);