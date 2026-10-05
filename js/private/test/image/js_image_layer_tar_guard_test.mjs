// Regression test for js/private/js_image_layer_tar.mjs -- the Node guard that
// wraps bsdtar for js_image_layer's tar-create actions and turns bsdtar's SILENT
// st_ino==0 corruption on Windows/NTFS into a hard build failure.
//
// The corruption itself only reproduces on Windows with degenerate NTFS inodes,
// so this test asserts the guard's two detection predicates against the exact
// observable signatures (the real "Can't add archive to itself" stderr line seen
// in CI, and a realistic `tar -tvf` hardlink listing), plus the benign cases that
// must NOT trip it (ordinary warnings, symlinks, regular files).
//
// Cross-platform and deterministic: no subprocess/tar spawn. Runs under
// `bazel test` (js_test) or directly via `node js_image_layer_tar_guard_test.mjs`.

import {
    isSelfReferenceDrop,
    findHardlinkLines,
    parseMtreeExpectedEntries,
    findMissingTarEntries,
} from '../../js_image_layer_tar_lib.mjs'

let failures = 0
function check(desc, cond) {
    if (cond) {
        console.log(`ok: ${desc}`)
    } else {
        failures++
        console.error(`FAIL: ${desc}`)
    }
}

// --- self-reference (silent drop) detection ---------------------------------
check(
    'self-ref: real CI stderr line is detected',
    isSelfReferenceDrop(
        "tar.exe: .../stack-trace@0.0.10/node_modules/stack-trace/lib/stack-trace.js: Can't add archive to itself"
    )
)
check('self-ref: bare message is detected', isSelfReferenceDrop("foo: Can't add archive to itself\n"))
check('self-ref: empty stderr is NOT flagged', !isSelfReferenceDrop(''))
check(
    'self-ref: benign "Removing leading /" warning is NOT flagged',
    !isSelfReferenceDrop("tar.exe: Removing leading '/' from member names\n")
)

// --- hardlink-member detection ----------------------------------------------
const CLEAN_LISTING = [
    '-r-xr-xr-x  0 0      0          12 Jan  1  1970 ./a.js',
    '-r-xr-xr-x  0 0      0          20 Jan  1  1970 ./main.js',
    'drwxr-xr-x  0 0      0           0 Jan  1  1970 ./dir',
].join('\n')

const SYMLINK_LISTING = [
    '-r-xr-xr-x  0 0      0          12 Jan  1  1970 ./a.js',
    'lrwxr-xr-x  0 0      0           0 Jan  1  1970 ./node_modules/x -> ../x@1.0.0/node_modules/x',
].join('\n')

const HARDLINK_LISTING = [
    '-r-xr-xr-x  0 0      0          12 Jan  1  1970 ./a.js',
    'hr-xr-xr-x  0 0      0           0 Jan  1  1970 ./b.js link to ./a.js',
].join('\n')

check('hardlink: clean listing has 0 hardlinks', findHardlinkLines(CLEAN_LISTING).length === 0)
check('hardlink: symlink listing has 0 hardlinks (symlinks are legitimate)', findHardlinkLines(SYMLINK_LISTING).length === 0)
check('hardlink: hardlink member is detected', findHardlinkLines(HARDLINK_LISTING).length === 1)

// --- parseMtreeExpectedEntries ----------------------------------------------
const MTREE_ALL_TYPES = [
    '#mtree',
    './a.js type=file nlink=1 size=12',
    './b.js type=link nlink=1 size=0',
    './dir type=dir',
    '',
].join('\n')

const entriesAllTypes = parseMtreeExpectedEntries(MTREE_ALL_TYPES)
check('mtree: file and link entries are counted (2)', entriesAllTypes.size === 2)
check('mtree: dir entry is NOT included', !entriesAllTypes.has('dir'))
check('mtree: file entry is present (./- prefix stripped)', entriesAllTypes.has('a.js'))
check('mtree: link entry is present (./- prefix stripped)', entriesAllTypes.has('b.js'))

// A path with an octal-escaped space: vis(3) encodes 0x20 as \040.
const MTREE_ESCAPED = '#mtree\n./some\\040file.js type=file nlink=1 size=0\n'
const entriesEscaped = parseMtreeExpectedEntries(MTREE_ESCAPED)
check('mtree: vis octal escape \\040 is decoded to space', entriesEscaped.has('some file.js'))

check('mtree: empty text returns empty set', parseMtreeExpectedEntries('').size === 0)
check('mtree: comment-only text returns empty set', parseMtreeExpectedEntries('#mtree\n').size === 0)

// --- findMissingTarEntries --------------------------------------------------
// Use a simple mtree with one file and one symlink.
const MTREE_TWO = '#mtree\n./a.js type=file nlink=1 size=12\n./b.js type=link nlink=1 size=0\n'
const expectedTwo = parseMtreeExpectedEntries(MTREE_TWO)

// Verbose listing containing both entries (no links missing).
const COMPLETE_VERBOSE = [
    '-r-xr-xr-x  0 0      0          12 Jan  1  1970 ./a.js',
    'lrwxr-xr-x  0 0      0           0 Jan  1  1970 ./b.js -> ../real/b.js',
].join('\n')

check(
    'missing: nothing reported when all entries are present (verbose)',
    findMissingTarEntries(expectedTwo, COMPLETE_VERBOSE).length === 0
)

// Verbose listing with the symlink dropped.
const INCOMPLETE_VERBOSE = '-r-xr-xr-x  0 0      0          12 Jan  1  1970 ./a.js\n'

const missingVerbose = findMissingTarEntries(expectedTwo, INCOMPLETE_VERBOSE)
check('missing: dropped entry is detected (verbose)', missingVerbose.length === 1)
check('missing: correct path is reported (verbose)', missingVerbose[0] === 'b.js')

// Non-verbose (plain-path) listing — also supported.
const COMPLETE_PLAIN = './a.js\n./b.js\n'
check(
    'missing: nothing reported when all entries are present (plain-path)',
    findMissingTarEntries(expectedTwo, COMPLETE_PLAIN).length === 0
)

const INCOMPLETE_PLAIN = './a.js\n'
const missingPlain = findMissingTarEntries(expectedTwo, INCOMPLETE_PLAIN)
check('missing: dropped entry is detected (plain-path)', missingPlain.length === 1)
check('missing: correct path is reported (plain-path)', missingPlain[0] === 'b.js')

if (failures > 0) {
    console.error(`\n${failures} assertion(s) failed`)
    process.exit(1)
}
console.log('\nall js_image_layer_tar guard assertions passed')
