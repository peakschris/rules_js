// Wrapper around the tar toolchain binary for js_image_layer's tar-create actions.
//
// WHY THIS EXISTS
// ---------------
// bsdtar on Windows/NTFS can SILENTLY DROP input files whose degenerate stat()
// identity (MSVC reports st_ino==0 for every file) collides with the output
// archive's identity. libarchive's self-reference guard then decides the input
// file "is" the archive, prints "<file>: Can't add archive to itself" to stderr,
// skips the file -- and still exits 0. Bazel records the action as successful and
// ships a layer that is missing files. This surfaces far downstream as
// `MODULE_NOT_FOUND` at container start (e.g. filerepo losing stack-trace/lib).
//
// A related st_ino==0 failure mode makes bsdtar's hardlink dedup false-link
// unrelated store files into shared content (the mtree `nlink=1` field defeats
// that one). Neither is fixable from the tar CLI (prebuilt bsdtar, no flag), so
// this wrapper turns both silent-corruption modes into a hard build failure:
//
//   1. Run `<tar> <create-args...>`, teeing tar's stderr through, and fail if tar
//      exits non-zero OR its stderr contains the self-reference signature.
//   2. List the produced archive and fail if it contains any hardlink member
//      (canary for the hardlink-dedup bug; also catches an nlink=1 regression).
//
// This file is the CLI entry point; it calls main() unconditionally (Bazel only
// ever executes it, never imports it). The detection predicates live in
// js_image_layer_tar_lib.mjs so they can be unit-tested without running main() --
// an ESM entry-point self-check is unreliable under Bazel on Windows (see the
// lib file's header).
//
// Usage:
//   node js_image_layer_tar.mjs --tar <tar-bin> --output <archive> --mtree <mtree-file> -- <tar-create-args...>

import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, readFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { createGzip } from 'node:zlib'
import {
    isSelfReferenceDrop,
    findHardlinkLines,
    parseMtreeExpectedEntries,
    findMissingTarEntries,
} from './js_image_layer_tar_lib.mjs'

// Run `<tar> <create-args...>`, resolving to { status, error, stderr }.
//
// On Windows the archive is NOT handed to bsdtar as `--file <output>`. libarchive
// registers a regular-file output as the "skip file" (archive_write_open_filename.c:
// `if (S_ISREG(st.st_mode)) archive_write_set_skip_file(a, st_dev, st_ino)`), and the
// mtree reader stamps every entry with fstat()'s dev/ino of the opened content file
// (archive_read_support_format_mtree.c). With the MSVC CRT st_ino is always 0, so every
// input file on the same drive as the output compares equal to the output archive and
// is dropped with "Can't add archive to itself". Whether a file collides depends only on
// which drive it physically lives on, so it is environment dependent and not fixable
// from the tar CLI. Instead bsdtar writes to a pipe on stdout (`--file -`; not
// S_ISREG, so no skip file is registered) and we stream it to <output> ourselves.
//
// Compression is NOT left to bsdtar when it writes to the pipe. libarchive pads the final
// *output* block of a non-regular-file archive with zeros up to the block size (10240), i.e.
// after the gzip trailer, which strict gzip readers (Go's, used by rules_img) reject with
// "gzip: invalid header". So for `--gzip` bsdtar emits a plain tar (its zero padding is
// harmless inside a tar) and we gzip it here. Any other compressor keeps the old direct
// `--file <output>` behaviour.
const OTHER_COMPRESSION_FLAGS = new Set([
    '-j', '-J', '-y', '-Z', '-z', '--bzip2', '--xz', '--lzma', '--lzip', '--lzop', '--lz4',
    '--zstd', '--lrzip', '--grzip', '--compress', '--use-compress-program', '--gzip', '--gunzip',
])

// Returns { args, gzipLevel } when tarArgs can be streamed (no compression, or plain gzip that
// we can reproduce in node), else undefined.
function planPipe(tarArgs, output) {
    const args = []
    let gzip = false
    let level = 6
    for (let i = 0; i < tarArgs.length; i++) {
        const a = tarArgs[i]
        if (i > 0 && tarArgs[i - 1] === '--file' && a === output) {
            args.push('-')
        } else if (a === '--gzip' || a === '-z' || a === '--gunzip') {
            gzip = true
        } else if (a.startsWith('--options=')) {
            const rest = []
            for (const o of a.slice('--options='.length).split(',')) {
                const m = /^gzip:(.*)$/.exec(o)
                if (!m) {
                    rest.push(o)
                } else if (m[1] === '!timestamp' || m[1] === 'timestamp') {
                    // node's gzip header never carries a timestamp
                } else if (/^compression-level=\d$/.test(m[1])) {
                    level = Number(m[1].slice('compression-level='.length))
                } else {
                    return undefined
                }
            }
            if (rest.length) args.push('--options=' + rest.join(','))
        } else if (OTHER_COMPRESSION_FLAGS.has(a) || a.startsWith('--use-compress-program=')) {
            return undefined
        } else {
            args.push(a)
        }
    }
    return args.includes('-') ? { args, gzipLevel: gzip ? level : undefined } : undefined
}

// Force the gzip header OS byte to 3 (unix) so output does not depend on the zlib build.
function fixGzipOsByte() {
    let first = true
    return new Transform({
        transform(chunk, _enc, cb) {
            if (first && chunk.length >= 10) {
                first = false
                chunk[9] = 3
            }
            cb(null, chunk)
        },
    })
}

function runTar(tarBin, tarArgs, output, spawnOpts) {
    return new Promise((resolve) => {
        let args = tarArgs
        let viaPipe = false
        let gzipLevel
        if (process.platform === 'win32') {
            const plan = planPipe(tarArgs, output)
            if (plan) {
                args = plan.args
                gzipLevel = plan.gzipLevel
                viaPipe = true
            }
        }
        if (!viaPipe) {
            const r = spawnSync(tarBin, args, { ...spawnOpts, stdio: ['inherit', 'inherit', 'pipe'] })
            resolve({ status: r.status, error: r.error, stderr: r.stderr || '' })
            return
        }
        const child = spawn(tarBin, args, { stdio: ['inherit', 'pipe', 'pipe'] })
        const chunks = []
        child.stderr.on('data', (d) => chunks.push(d))
        const sink = createWriteStream(output)
        const stages = gzipLevel === undefined ? [child.stdout, sink] : [child.stdout, createGzip({ level: gzipLevel }), fixGzipOsByte(), sink]
        const written = pipeline(...stages).then(
            () => undefined,
            (e) => e
        )
        let spawnError
        child.on('error', (e) => {
            spawnError = e
            sink.destroy()
        })
        child.on('close', async (status) => {
            const writeError = await written
            const stderr = Buffer.concat(chunks).toString('utf8')
            resolve({
                status,
                error: spawnError || writeError,
                stderr,
            })
        })
    })
}

async function main() {
    const argv = process.argv.slice(2)
    const sep = argv.indexOf('--')
    if (sep < 0) {
        process.stderr.write('js_image_layer_tar: missing `--` separator before tar args\n')
        process.exit(1)
    }
    const head = argv.slice(0, sep)
    const tarArgs = argv.slice(sep + 1)

    let tarBin
    let output
    let mtree
    for (let i = 0; i < head.length; i += 2) {
        if (head[i] === '--tar') {
            tarBin = head[i + 1]
        } else if (head[i] === '--output') {
            output = head[i + 1]
        } else if (head[i] === '--mtree') {
            mtree = head[i + 1]
        } else {
            process.stderr.write(`js_image_layer_tar: unknown argument ${head[i]}\n`)
            process.exit(1)
        }
    }
    if (!tarBin || !output || !mtree) {
        process.stderr.write('js_image_layer_tar: --tar, --output, and --mtree are required\n')
        process.exit(1)
    }

    const SPAWN_OPTS = { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }

    // 1. Create the archive, capturing stderr while still surfacing it to the user.
    const create = await runTar(tarBin, tarArgs, output, SPAWN_OPTS)
    const createErr = create.stderr
    if (createErr) {
        process.stderr.write(createErr)
    }
    if (create.error) {
        process.stderr.write(`js_image_layer_tar: failed to run tar: ${create.error.message}\n`)
        process.exit(1)
    }
    if (create.status !== 0) {
        process.exit(create.status === null ? 1 : create.status)
    }
    if (isSelfReferenceDrop(createErr)) {
        process.stderr.write(
            '\njs_image_layer_tar: FATAL -- tar reported "Can\'t add archive to itself" and SILENTLY\n' +
                `dropped one or more files from ${output}. This is the bsdtar st_ino==0 self-reference\n` +
                'bug on Windows/NTFS; the resulting layer is CORRUPT (missing files). Failing the build\n' +
                'instead of shipping a broken image layer.\n'
        )
        process.exit(1)
    }

    // 2. List the produced archive once and reuse the output for both the
    //    hardlink canary (step 2a) and the per-entry completeness check (step 2b).
    //    The verbose listing is required for hardlink detection; the completeness
    //    check can parse paths out of the same verbose lines.
    const list = spawnSync(tarBin, ['-tvf', output], SPAWN_OPTS)
    if (list.status === 0 && typeof list.stdout === 'string') {
        // 2a. Hardlink canary: a correct js_image_layer never emits hardlinks
        //     (the mtree carries nlink=1). Any hardlink member means the
        //     st_ino==0 hardlink-dedup bug corrupted the archive by pointing
        //     unrelated files at shared content.
        const hardlinks = findHardlinkLines(list.stdout)
        if (hardlinks.length > 0) {
            process.stderr.write(
                `\njs_image_layer_tar: FATAL -- ${hardlinks.length} hardlink member(s) found in ${output}:\n` +
                    hardlinks
                        .slice(0, 10)
                        .map((l) => `    ${l}`)
                        .join('\n') +
                    '\n' +
                    'js_image_layer never creates hardlinks; this is the bsdtar st_ino==0 hardlink-dedup\n' +
                    'bug (unrelated files false-linked to shared content -> corrupt layer). The mtree\n' +
                    'nlink=1 field should prevent this; failing the build.\n'
            )
            process.exit(1)
        }

        // 2b. Per-entry completeness check: every type=file and type=link path
        //     declared in the mtree must appear in the produced tar. bsdtar can
        //     silently drop entries (e.g. the st_ino==0 self-reference bug) and
        //     still exit 0; this catch-all turns any such silent drop into a hard
        //     failure regardless of cause.
        const mtreeText = readFileSync(mtree, 'utf8')
        const expected = parseMtreeExpectedEntries(mtreeText)
        const missing = findMissingTarEntries(expected, list.stdout)
        if (missing.length > 0) {
            process.stderr.write(
                `\njs_image_layer_tar: FATAL -- ${missing.length} file(s)/link(s) declared in the\n` +
                    `layer mtree are MISSING from the packed tar '${output}':\n` +
                    missing.map((m) => `  - ${m}`).join('\n') +
                    '\nbsdtar silently dropped these entries; the layer is corrupt.\n'
            )
            process.exit(1)
        }
    }

    process.exit(0)
}

main().catch((e) => {
    process.stderr.write(`js_image_layer_tar: ${e && e.stack ? e.stack : e}
`)
    process.exit(1)
})
