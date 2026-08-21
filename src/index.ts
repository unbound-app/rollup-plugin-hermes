import type { NormalizedOutputOptions, OutputBundle, OutputChunk, Plugin, PluginContext } from 'rollup';
import type { HermesTarget } from './manifest';
import { writeFile, rm, readFile, mkdir } from 'fs/promises';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

import { resolveHermesTargets } from './manifest';

type HermesOptions = {
	hermesc?: string;
	versions?: number;
	manifestUrl?: string;
	cacheDir?: string;
};

async function compile(ctx: PluginContext, dir: string, js: string): Promise<Buffer | null> {
	const extension = process.platform === 'win32' ? '.exe' : '';
	const bin = resolve(dir, process.platform, 'hermesc' + extension);

	if (!existsSync(bin)) {
		ctx.warn(`The hermesc binary is either not supported for your OS or cannot be found at ${bin}. Skipping.`);
		return null;
	}

	const temp = join(tmpdir(), 'hermesc');
	if (!existsSync(temp)) await mkdir(temp);

	const bytecode = join(temp, randomBytes(8).readUint32LE(0) + '.bundle');
	const args = ['--emit-binary', '--out', bytecode, '-Wno-direct-eval', '-Wno-undefined-variable', js];

	const { code, stderr } = await new Promise<{ code: number | null; stderr: string; }>((resolve, reject) => {
		const child = spawn(bin, args, { shell: true });

		let stderr = '';

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', ctx.debug);

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk) => (stderr += chunk));

		child.on('error', reject);
		child.on('close', (code) => resolve({ code, stderr }));
	});

	if (code !== 0) {
		const detail = stderr.trim() || `hermesc exited with code ${code}.`;
		ctx.error(`hermesc failed to compile:\n${detail}`);
	}

	if (stderr.trim()) ctx.warn(stderr.trim());

	const asset = await readFile(bytecode);
	await rm(bytecode, { force: true });

	return asset;
}

function hermesc(pluginOptions?: HermesOptions): Plugin {
	let targets: HermesTarget[] | undefined;

	return {
		name: 'hermesc',

		async generateBundle(options: NormalizedOutputOptions, bundle: OutputBundle, isWrite: boolean) {
			const out = options.file?.split('/');
			if (!out) return;

			const file = out.pop();
			const name = file.split('.').shift();

			const output = bundle[file] as OutputChunk;
			if (!output) return;

			targets ??= pluginOptions?.hermesc
				? [{ version: null, dir: pluginOptions.hermesc }]
				: await resolveHermesTargets(this, pluginOptions ?? {});

			const temp = join(tmpdir(), 'hermesc');
			if (!existsSync(temp)) await mkdir(temp);

			const js = join(temp, randomBytes(8).readUint32LE(0) + '.js');
			await writeFile(js, output.code, 'utf-8');

			for (const target of targets) {
				if (!target.dir) {
					this.warn(`hermesc for bytecode version ${target.version} could not be resolved from the manifest cache. Skipping.`);
					continue;
				}

				const fileName = target.version === null ? `${name}.bundle` : `${name}.${target.version}.bundle`;

				this.info(`${options.file} -> ${options.file.replace(file, fileName)}...`);

				const asset = await compile(this, target.dir, js);
				if (!asset) continue;

				this.emitFile({ type: 'asset', fileName, source: asset });

				this.info(`( ͡° ͜ʖ ͡°) Bytecode compiled to ${fileName}`);
			}

			await rm(js, { force: true });
		},

		async buildEnd() {
			const temp = join(tmpdir(), 'hermesc');

			if (existsSync(temp)) {
				await rm(temp, { recursive: true, force: true });
			}
		},
	};
}

export = hermesc;
