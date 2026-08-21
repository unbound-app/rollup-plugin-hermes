import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';

import manifest from '../dist/manifest.js';

const { fetchManifest, resolveHermesTargets } = manifest;

const MANIFEST = {
	latest: [98, 96, 94],
	versions: { '98': { npm: '98.0.0' }, '96': { npm: '96.0.0' }, '94': { npm: '94.0.0' } },
};

const ctx = {
	warn: () => {},
	error: (msg) => {
		throw new Error(msg);
	},
};

let cacheDir;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), 'rph-test-'));
});

afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true });
});

function jsonResponse(body, { status = 200, etag } = {}) {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: { get: (name) => (name.toLowerCase() === 'etag' && etag ? etag : null) },
		text: async () => JSON.stringify(body),
	};
}

test('200 stores etag and manifest to cache', async () => {
	const stubFetch = async () => jsonResponse(MANIFEST, { etag: '"abc123"' });

	const manifest = await fetchManifest(ctx, { cacheDir }, { fetch: stubFetch });

	assert.deepEqual(manifest, MANIFEST);
	assert.equal(readFileSync(join(cacheDir, 'etag'), 'utf-8'), '"abc123"');
	assert.deepEqual(JSON.parse(readFileSync(join(cacheDir, 'manifest.json'), 'utf-8')), MANIFEST);
});

test('subsequent 304 reuses cached manifest and sends If-None-Match', async () => {
	writeFileSync(join(cacheDir, 'etag'), '"abc123"');
	writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify(MANIFEST));

	let sentHeader;
	let bodyRead = false;

	const stubFetch = async (_url, init) => {
		sentHeader = init.headers['If-None-Match'];
		return {
			status: 304,
			ok: false,
			headers: { get: () => null },
			text: async () => {
				bodyRead = true;
				return '';
			},
		};
	};

	const manifest = await fetchManifest(ctx, { cacheDir }, { fetch: stubFetch });

	assert.equal(sentHeader, '"abc123"');
	assert.equal(bodyRead, false);
	assert.deepEqual(manifest, MANIFEST);
});

test('network error with cached manifest falls back to cache', async () => {
	writeFileSync(join(cacheDir, 'manifest.json'), JSON.stringify(MANIFEST));

	const stubFetch = async () => {
		throw new Error('ECONNREFUSED');
	};

	const manifest = await fetchManifest(ctx, { cacheDir }, { fetch: stubFetch });

	assert.deepEqual(manifest, MANIFEST);
});

test('network error without cache errors', async () => {
	const stubFetch = async () => {
		throw new Error('ECONNREFUSED');
	};

	await assert.rejects(
		() => fetchManifest(ctx, { cacheDir }, { fetch: stubFetch }),
		/no cached copy is available/,
	);
});

test('resolveHermesTargets downloads each held version once', async () => {
	const stubFetch = async () => jsonResponse(MANIFEST, { etag: '"v1"' });

	const downloaded = [];
	const stubDownload = async (npmVersion, root) => {
		downloaded.push(npmVersion);
		mkdirSync(resolve(root, process.platform), { recursive: true });
		writeFileSync(resolve(root, process.platform, 'hermesc' + (process.platform === 'win32' ? '.exe' : '')), 'binary');
	};

	const targets = await resolveHermesTargets(ctx, { cacheDir }, { fetch: stubFetch, download: stubDownload });

	assert.deepEqual(downloaded, ['98.0.0', '96.0.0', '94.0.0']);
	assert.deepEqual(
		targets.map((t) => t.version),
		[98, 96, 94],
	);
	for (const target of targets) assert.ok(target.dir);
});

test('resolveHermesTargets respects the versions option', async () => {
	const stubFetch = async () => jsonResponse(MANIFEST, { etag: '"v1"' });

	const stubDownload = async (_npmVersion, root) => {
		mkdirSync(resolve(root, process.platform), { recursive: true });
		writeFileSync(resolve(root, process.platform, 'hermesc' + (process.platform === 'win32' ? '.exe' : '')), 'binary');
	};

	const targets = await resolveHermesTargets(ctx, { cacheDir, versions: 1 }, { fetch: stubFetch, download: stubDownload });

	assert.deepEqual(
		targets.map((t) => t.version),
		[98],
	);
});

test('cache hit skips download when the binary already exists on disk', async () => {
	const stubFetch = async () => jsonResponse(MANIFEST, { etag: '"v1"' });
	const extension = process.platform === 'win32' ? '.exe' : '';

	for (const npm of ['98.0.0', '96.0.0', '94.0.0']) {
		const platformDir = resolve(cacheDir, 'hermesc', npm, process.platform);
		mkdirSync(platformDir, { recursive: true });
		writeFileSync(resolve(platformDir, 'hermesc' + extension), 'binary');
	}

	let downloadCalled = false;
	const stubDownload = async () => {
		downloadCalled = true;
	};

	const targets = await resolveHermesTargets(ctx, { cacheDir }, { fetch: stubFetch, download: stubDownload });

	assert.equal(downloadCalled, false);
	assert.equal(targets.length, 3);
	for (const target of targets) assert.ok(existsSync(resolve(target.dir, process.platform, 'hermesc' + extension)));
});
