// Pure detection predicates for the js_image_layer tar guard.
//
// Kept in a separate library module (not js_image_layer_tar.mjs) so unit tests
// can import these predicates WITHOUT the CLI's top-level main() executing. The
// usual ESM "am I the entry point?" self-check
// (`path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`) is
// unreliable under Bazel on Windows: Node realpath's the main entry through the
// `external/<repo>` junction, so import.meta.url and process.argv[1] disagree and
// main() would silently never run. Splitting lib/bin sidesteps that entirely.
//
// See js_image_layer_tar.mjs for the full rationale on why the guard exists.

// libarchive's self-reference guard message. When bsdtar prints this it has
// SILENTLY skipped the named input file, so the archive is missing content.
export const SELF_REFERENCE_RE = /Can't add archive to itself/

/**
 * True if tar's stderr shows it silently dropped a file via the self-reference guard.
 * @param {string} stderr
 * @returns {boolean}
 */
export function isSelfReferenceDrop(stderr) {
    return SELF_REFERENCE_RE.test(stderr || '')
}

/**
 * Return the hardlink member lines from a `tar -tvf` verbose listing. A hardlink
 * renders as `<path> link to <target>` (distinct from a symlink's `<path> -> <target>`)
 * with an `h` file-type char, e.g. `hr-xr-xr-x  0 0 0 0 <date> ./b link to ./a`.
 * @param {string} listing
 * @returns {string[]}
 */
export function findHardlinkLines(listing) {
    return (listing || '')
        .split('\n')
        .filter((l) => / link to /.test(l) || /^\s*h[rwxsStT-]{9}\s/.test(l))
}

// ---------------------------------------------------------------------------
// Helpers for the per-entry completeness check (parseMtreeExpectedEntries /
// findMissingTarEntries). These mirror the normalize() / unvis() helpers in
// the reference pack_layer.mjs implementation.
// ---------------------------------------------------------------------------

// Strip leading "./" prefixes and trailing "/" suffixes so mtree paths and
// tar-listing paths can be compared on a level playing field.
function _normalizePath(p) {
    let s = p
    while (s.startsWith('./')) s = s.slice(2)
    while (s.endsWith('/')) s = s.slice(0, -1)
    return s
}

// Decode mtree strsvis escapes (\ooo octal, \\ backslash) in a path token.
// mtree encodes non-ASCII and some ASCII special bytes via vis(3): a byte
// value <v> is written as \<octal3>; a literal backslash as \\. Other
// sequences are passed through unchanged (defensive).
//
// Edge cases NOT handled: vis's \a \b \f \n \r \t \v short-form escapes and
// the \M- high-byte notation. These are uncommon in file paths in practice.
function _unvis(s) {
    let out = ''
    for (let i = 0; i < s.length; i += 1) {
        if (s[i] === '\\' && i + 3 < s.length + 1) {
            const oct = s.slice(i + 1, i + 4)
            if (/^[0-7]{3}$/.test(oct)) {
                out += String.fromCharCode(parseInt(oct, 8))
                i += 3
                continue
            }
            if (s[i + 1] === '\\') {
                out += '\\'
                i += 1
                continue
            }
        }
        out += s[i]
    }
    return out
}

/**
 * Parse the set of paths that the tar layer is expected to contain, from an
 * mtree spec text.  Only `type=file` and `type=link` (symlink) entries are
 * collected; directories and other types are omitted.
 *
 * Paths are decoded (mtree strsvis/vis encoding: \ooo octal + \\ backslash)
 * and normalised (leading `./` and trailing `/` stripped) so they can be
 * compared directly against the output of `findMissingTarEntries`.
 *
 * @param {string} mtreeText  Full text of the mtree spec file.
 * @returns {Set<string>}
 */
export function parseMtreeExpectedEntries(mtreeText) {
    const expected = new Set()
    for (const rawLine of (mtreeText || '').split('\n')) {
        const line = rawLine.trim()
        if (line === '' || line.startsWith('#')) continue
        const firstSpace = line.indexOf(' ')
        const pathToken = firstSpace === -1 ? line : line.slice(0, firstSpace)
        const attrs = firstSpace === -1 ? '' : line.slice(firstSpace + 1)
        if (/(^|\s)type=(file|link)(\s|$)/.test(attrs)) {
            expected.add(_normalizePath(_unvis(pathToken)))
        }
    }
    return expected
}

/**
 * Return the paths from `expectedSet` that are absent from a `bsdtar -tvf`
 * or `bsdtar --list` listing.  Both verbose (`-tvf`) and non-verbose
 * (`--list`) output are accepted: verbose lines are recognised by the leading
 * permissions field and parsed to extract the bare path; plain-path lines are
 * used as-is.
 *
 * Verbose format: `<perms>  <nlink> <uid>  <gid>  <size> <month> <day>
 * <year|time> <path> [link to <target> | -> <target>]`
 *
 * Caveat: paths that literally contain the substrings " link to " or " -> "
 * will be incorrectly truncated. This is not expected in container layer
 * paths in practice.
 *
 * @param {Set<string>} expectedSet   Output of `parseMtreeExpectedEntries`.
 * @param {string}      tarListOutput stdout of `bsdtar -tvf` or `bsdtar --list`.
 * @returns {string[]}  Sorted list of missing normalised paths.
 */
export function findMissingTarEntries(expectedSet, tarListOutput) {
    // Verbose listing line: 8 whitespace-separated tokens (perms, nlink, uid,
    // gid, size, month, day, year-or-time) followed by the path (and optional
    // link annotation).  The \s+ between fields handles variable-width columns.
    const VERBOSE_LINE_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)$/
    const actual = new Set()
    for (const rawLine of (tarListOutput || '').split('\n')) {
        const line = rawLine.replace(/\r$/, '')
        if (line === '') continue
        let entry
        const m = line.match(VERBOSE_LINE_RE)
        if (m) {
            // Verbose: strip hardlink (" link to <target>") and symlink
            // (" -> <target>") annotations to get the bare path.
            let rest = m[1]
            const linkIdx = rest.indexOf(' link to ')
            if (linkIdx !== -1) rest = rest.slice(0, linkIdx)
            const symlinkIdx = rest.indexOf(' -> ')
            if (symlinkIdx !== -1) rest = rest.slice(0, symlinkIdx)
            entry = rest
        } else {
            // Non-verbose: the line is the path itself.
            entry = line
        }
        actual.add(_normalizePath(entry))
    }
    const missing = []
    for (const expected of expectedSet) {
        if (!actual.has(expected)) {
            missing.push(expected)
        }
    }
    missing.sort()
    return missing
}
