import type { PluginContext } from 'rollup';
import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { writeFile, readFile, mkdir, readdir, rename, chmod } from 'fs/promises';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { tmpdir } from 'os';

const PACKAGE_NAME = '@unbound-app/hermesc';
const DEFAULT_MANIFEST_URL = 'https://raw.githubusercontent.com/unbound-app/hermesc/main/manifest.json';
const DEFAULT_HELD_VERSIONS = 3;

export interface HermesTarget {
	/** Bytecode version this binary produces, or null when explicitly overridden via options. */
	version: number | null;
	/** Directory containing the per-platform hermesc binaries (linux/darwin/win32), or null if not installed. */
	dir: string | null;
}

export interface HermesManifest {
	latest: number[];
	versions: Record<string, VersionEntry>;
}

type VersionEntry = { npm: string; };

export interface ManifestOptions {
	manifestUrl?: string;
	cacheDir?: string;
	versions?: number;
}

type FetchLike = typeof fetch;

type Downloader = (npmVersion: string, root: string) => Promise<void>;

export interface ManifestDeps {
	fetch?: FetchLike;
	download?: Downloader;
}

function defaultCacheDir(): string {
	return resolve(process.cwd(), 'node_modules', '.cache', 'rollup-plugin-hermes');
}

async function readCachedManifest(cacheDir: string): Promise<HermesManifest | null> {
	const path = join(cacheDir, 'manifest.json');
	if (!existsSync(path)) return null;

	try {
		return JSON.parse(await readFile(path, 'utf-8')) as HermesManifest;
	} catch {
		return null;
	}
}

async function readStoredEtag(cacheDir: string): Promise<string | null> {
	const path = join(cacheDir, 'etag');
	if (!existsSync(path)) return null;

	return (await readFile(path, 'utf-8')).trim() || null;
}

async function persistManifest(cacheDir: string, body: string, etag: string | null): Promise<void> {
	await mkdir(cacheDir, { recursive: true });
	await writeFile(join(cacheDir, 'manifest.json'), body, 'utf-8');
	if (etag) await writeFile(join(cacheDir, 'etag'), etag, 'utf-8');
}

export async function fetchManifest(
	ctx: PluginContext,
	options: ManifestOptions = {},
	deps: ManifestDeps = {},
): Promise<HermesManifest> {
	const doFetch = deps.fetch ?? fetch;
	const url = options.manifestUrl ?? DEFAULT_MANIFEST_URL;
	const cacheDir = options.cacheDir ?? defaultCacheDir();

	const storedEtag = await readStoredEtag(cacheDir);

	let response: Response;
	try {
		const headers: Record<string, string> = {};
		if (storedEtag) headers['If-None-Match'] = storedEtag;

		response = await doFetch(url, { headers });
	} catch (error: any) {
		const cached = await readCachedManifest(cacheDir);
		if (cached) {
			ctx.warn(`Failed to fetch hermesc manifest (${error?.message ?? error}). Using cached manifest.`);
			return cached;
		}

		return ctx.error(`Failed to fetch hermesc manifest from ${url} and no cached copy is available: ${error?.message ?? error}`);
	}

	if (response.status === 304) {
		const cached = await readCachedManifest(cacheDir);
		if (cached) return cached;

		return ctx.error(`hermesc manifest server returned 304 but no cached manifest exists at ${cacheDir}.`);
	}

	if (!response.ok) {
		const cached = await readCachedManifest(cacheDir);
		if (cached) {
			ctx.warn(`hermesc manifest request failed with status ${response.status}. Using cached manifest.`);
			return cached;
		}

		return ctx.error(`Failed to fetch hermesc manifest from ${url}: ${response.status}`);
	}

	const body = await response.text();
	const manifest = JSON.parse(body) as HermesManifest;

	await persistManifest(cacheDir, body, response.headers.get('etag'));

	return manifest;
}

async function downloadVersion(npmVersion: string, root: string): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), 'hermesc-'));

	try {
		execSync(`npm pack ${PACKAGE_NAME}@${npmVersion} --silent --pack-destination "${work}"`, { stdio: 'pipe' });

		const tarball = (await readdir(work)).find((file) => file.endsWith('.tgz'));
		if (!tarball) throw new Error(`npm pack did not produce a tarball for ${npmVersion}.`);

		execFileSync('tar', ['-xzf', tarball, '-C', work], { cwd: work });

		const extracted = join(work, 'package');
		await mkdir(root, { recursive: true });

		for (const platform of await readdir(extracted)) {
			const dest = join(root, platform);
			rmSync(dest, { recursive: true, force: true });
			await rename(join(extracted, platform), dest);
		}
	} finally {
		rmSync(work, { recursive: true, force: true });
	}

	if (process.platform !== 'win32') {
		const bin = resolve(root, process.platform, 'hermesc');
		if (existsSync(bin)) await chmod(bin, 0o755);
	}
}

export async function resolveHermesTargets(
	ctx: PluginContext,
	options: ManifestOptions = {},
	deps: ManifestDeps = {},
): Promise<HermesTarget[]> {
	const download = deps.download ?? downloadVersion;
	const cacheDir = options.cacheDir ?? defaultCacheDir();
	const held = options.versions ?? DEFAULT_HELD_VERSIONS;

	const manifest = await fetchManifest(ctx, options, deps);

	const extension = process.platform === 'win32' ? '.exe' : '';
	const targets: HermesTarget[] = [];

	for (const bytecode of manifest.latest.slice(0, held)) {
		const entry = manifest.versions[String(bytecode)];

		if (!entry) {
			ctx.warn(`hermesc manifest is missing an entry for bytecode version ${bytecode}. Skipping.`);
			continue;
		}

		const root = join(cacheDir, 'hermesc', entry.npm);
		const bin = resolve(root, process.platform, 'hermesc' + extension);

		if (!existsSync(bin)) {
			try {
				await download(entry.npm, root);
			} catch (error: any) {
				ctx.warn(`Failed to download hermesc ${entry.npm} (bytecode ${bytecode}): ${error?.message ?? error}. Skipping.`);
				targets.push({ version: bytecode, dir: null });
				continue;
			}
		}

		targets.push({ version: bytecode, dir: root });
	}

	return targets;
}

export default { fetchManifest, resolveHermesTargets };
