import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, beforeEach, afterEach } from 'node:test';

import hermes from '../dist/index.js';

const FAKE_HERMESC = `#!/bin/sh
echo "$@" > "$(dirname "$0")/args"
out=""
map=0
while [ $# -gt 0 ]; do
	case "$1" in
		--out) out="$2"; shift ;;
		-output-source-map) map=1 ;;
	esac
	shift
done
printf 'bytecode' > "$out"
if [ $map = 1 ] && [ -z "$FAKE_SKIP_MAP" ]; then
	printf '{"version":3,"sources":["/tmp/hermesc/123.js"],"names":[],"mappings":"AAAA"}' > "$out.map"
fi
`;

let dir;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'rph-compile-'));
	mkdirSync(join(dir, process.platform));

	const bin = join(dir, process.platform, 'hermesc');
	writeFileSync(bin, FAKE_HERMESC);
	chmodSync(bin, 0o755);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function build(flags) {
	const plugin = hermes({ hermesc: dir, flags });
	const emitted = {};

	const ctx = {
		info: () => {},
		warn: () => {},
		debug: () => {},
		error: (msg) => {
			throw new Error(msg);
		},
		emitFile: (file) => (emitted[file.fileName] = file.source),
	};

	const bundle = { 'unbound.js': { code: 'throw 1;' } };

	await plugin.generateBundle.call(ctx, { file: 'dist/unbound.js' }, bundle, true);
	await plugin.buildEnd.call(ctx);

	return {
		emitted,
		args: readFileSync(join(dir, process.platform, 'args'), 'utf-8')
			.trim()
			.split(' '),
	};
}

test('passes flags to hermesc before the input file', async () => {
	const { args } = await build(['-O', '-g0', '-output-source-map']);

	assert.deepEqual(args.slice(-4, -1), ['-O', '-g0', '-output-source-map']);
	assert.match(args.at(-1), /\.js$/);
});

test('emits the hermesc source map next to the bundle with the chunk as its source', async () => {
	const { emitted } = await build(['-output-source-map']);

	assert.equal(emitted['unbound.bundle'].toString(), 'bytecode');
	assert.deepEqual(JSON.parse(emitted['unbound.bundle.map']).sources, ['unbound.js']);
	assert.equal(JSON.parse(emitted['unbound.bundle.map']).mappings, 'AAAA');
});

test('fails when -output-source-map was passed but hermesc wrote no map', async () => {
	process.env.FAKE_SKIP_MAP = '1';

	try {
		await assert.rejects(build(['-output-source-map']), /wrote no map/);
	} finally {
		delete process.env.FAKE_SKIP_MAP;
	}
});

test('emits no source map without -output-source-map', async () => {
	const { emitted, args } = await build();

	assert.deepEqual(Object.keys(emitted), ['unbound.bundle']);
	assert.ok(!args.includes('-output-source-map'));
});
