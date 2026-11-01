// Exercises syncs of the js_run_devserver sandbox without the node fs patches, as on Windows where
// they are always disabled: a runfile is then a symlink to the Bazel output, and the sandbox gets a
// symlink to the runfile. Bazel rewrites the output on a rebuild but leaves the runfile symlink, and
// its timestamps, as they were.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devserver-symlinked-'))
const runfiles = path.join(base, 'runfiles')
const main = path.join(runfiles, '_main')

// The module reads these when it is loaded
Object.assign(process.env, {
    JS_BINARY__RUNFILES: runfiles,
    JS_BINARY__WORKSPACE: '_main',
    JS_BINARY__EXECROOT: base,
    JS_BINARY__BINDIR: 'bazel-out',
})

function check(description, actual, expected) {
    if (actual !== expected) {
        console.error(
            `ERROR: ${description}: expected '${expected}' but got '${actual}'`
        )
        process.exit(1)
    }
}

// Writes a Bazel output with the given modification time and links its runfile to it
function writeOutput(file, contents, mtime) {
    const output = path.join(base, 'bazel-out', file)
    fs.mkdirSync(path.dirname(output), { recursive: true })
    fs.writeFileSync(output, contents)
    fs.utimesSync(output, mtime, mtime)
    const runfile = path.join(main, file)
    if (!fs.existsSync(runfile)) {
        fs.mkdirSync(path.dirname(runfile), { recursive: true })
        fs.symlinkSync(output, runfile)
    }
    return output
}

async function resync(devserver, protocol, sandbox, config, file) {
    const entriesPath = path.join(sandbox, '..', 'entries.json')
    fs.writeFileSync(entriesPath, JSON.stringify([[file, 0]]))
    if (protocol === 'ibazel') {
        await devserver.ibazelBuildCompleted(config, entriesPath, sandbox)
    } else {
        await devserver.watchProtocolCycle(config, entriesPath, sandbox, {
            kind: 'CYCLE',
            sources: { [`_main/${file}`]: { is_symlink: true } },
        })
    }
}

for (const protocol of ['ibazel', 'watch']) {
    const file = `app/${protocol}.js`
    const output = writeOutput(file, 'v1', new Date(2020, 0, 1))
    const devserver = await import(
        `../../devserver/js_run_devserver.mjs?${protocol}`
    )
    devserver.applyConfig({}, '0')
    const sandbox = path.join(
        fs.mkdtempSync(path.join(base, 'js_run_devserver-')),
        '_main'
    )
    const link = path.join(sandbox, file)
    const config = {}

    await resync(devserver, protocol, sandbox, config, file)
    check(
        `${protocol}: symlinked file linked`,
        fs.lstatSync(link).isSymbolicLink(),
        true
    )
    // Watchers that lstat the link and those that stat it see the same modification time
    check(
        `${protocol}: link has the timestamp of the output`,
        fs.lstatSync(link).mtimeMs,
        fs.statSync(output).mtimeMs
    )

    const ino = fs.lstatSync(link, { bigint: true }).ino
    writeOutput(file, 'v2', new Date(2021, 0, 1))
    await resync(devserver, protocol, sandbox, config, file)
    check(
        `${protocol}: changed output visible in the sandbox`,
        fs.readFileSync(link, 'utf8'),
        'v2'
    )
    check(
        `${protocol}: link has the timestamp of the changed output`,
        fs.lstatSync(link).mtimeMs,
        fs.statSync(output).mtimeMs
    )
    check(
        `${protocol}: link kept`,
        fs.lstatSync(link, { bigint: true }).ino,
        ino
    )
}

// A changed output is resynced although its runfile symlink is unchanged, and an unchanged one is
// not. Detected here through the timestamps of the sandbox link, which the test resets.
{
    const file = 'app/unchanged.js'
    const output = writeOutput(file, 'v1', new Date(2020, 0, 1))
    const devserver = await import(
        '../../devserver/js_run_devserver.mjs?unchanged'
    )
    devserver.applyConfig({}, '0')
    const sandbox = path.join(
        fs.mkdtempSync(path.join(base, 'js_run_devserver-')),
        '_main'
    )
    const link = path.join(sandbox, file)
    const config = {}
    await resync(devserver, 'ibazel', sandbox, config, file)

    const reset = new Date(2000, 0, 1)
    fs.lutimesSync(link, reset, reset)
    await resync(devserver, 'ibazel', sandbox, config, file)
    check(
        'unchanged output not resynced',
        fs.lstatSync(link).mtimeMs,
        reset.getTime()
    )

    fs.utimesSync(output, new Date(2022, 0, 1), new Date(2022, 0, 1))
    await resync(devserver, 'ibazel', sandbox, config, file)
    check(
        'touched output resynced',
        fs.lstatSync(link).mtimeMs,
        fs.statSync(output).mtimeMs
    )
}

fs.rmSync(base, { recursive: true, force: true })
