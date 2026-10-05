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

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
    isSelfReferenceDrop,
    findHardlinkLines,
    parseMtreeExpectedEntries,
    findMissingTarEntries,
} from './js_image_layer_tar_lib.mjs'

function main() {
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
    const create = spawnSync(tarBin, tarArgs, { ...SPAWN_OPTS, stdio: ['inherit', 'inherit', 'pipe'] })
    const createErr = create.stderr || ''
    if (createErr) {
        process.stderr.write(createErr)
    }
    if (create.error) {
        process.stderr.write(`js_image_layer_tar: failed to spawn tar: ${create.error.message}\n`)
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

main()
