// Exercises re-syncs of the js_run_devserver sandbox, as ibazel and the watch protocol perform them,
// against a synthetic runfiles tree.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'devserver-sync-'))
const runfiles = path.join(base, 'runfiles')
const main = path.join(runfiles, '_main')

function write(p) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, p)
}

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

// Each scenario gets its own instance of the module, since it keeps what it has synced into a
// sandbox in module state, and its own sandbox.
async function newDevserver(scenario) {
    const devserver = await import(
        `../../devserver/js_run_devserver.mjs?${scenario}`
    )
    const sandbox = path.join(
        fs.mkdtempSync(path.join(base, 'js_run_devserver-')),
        '_main'
    )
    return { devserver, sandbox }
}

async function resync(devserver, protocol, sandbox, config, files, sources) {
    const entriesPath = path.join(sandbox, '..', 'entries.json')
    fs.writeFileSync(entriesPath, JSON.stringify(files))
    if (protocol === 'ibazel') {
        await devserver.ibazelBuildCompleted(config, entriesPath, sandbox)
    } else {
        await devserver.watchProtocolCycle(
            config,
            entriesPath,
            sandbox,
            sources === undefined
                ? { kind: 'CYCLE_RESET', sources: {} }
                : { kind: 'CYCLE', sources }
        )
    }
}

// A changed file is overwritten in place rather than deleted and recreated, which watchers can miss
// (https://github.com/aspect-build/rules_js/issues/3039), also when its copy is read-only.
for (const protocol of ['ibazel', 'watch']) {
    const file = `app/${protocol}-overwritten.js`
    const src = path.join(main, file)
    const writeSource = (contents, mtime) => {
        if (fs.existsSync(src)) {
            fs.chmodSync(src, 0o644)
        }
        write(src)
        fs.writeFileSync(src, contents)
        fs.chmodSync(src, 0o444)
        fs.utimesSync(src, mtime, mtime)
    }
    writeSource('v1', new Date(2020, 0, 1))
    const { devserver, sandbox } = await newDevserver(`${protocol}-overwritten`)
    const config = {}
    const entries = [[file, 0]]
    const copy = path.join(sandbox, file)
    await resync(devserver, protocol, sandbox, config, entries)
    check(`${protocol}: file copied`, fs.readFileSync(copy, 'utf8'), 'v1')

    const ino = fs.lstatSync(copy, { bigint: true }).ino
    writeSource('v2', new Date(2021, 0, 1))
    await resync(devserver, protocol, sandbox, config, entries, {
        [`_main/${file}`]: {},
    })
    check(
        `${protocol}: changed file copied`,
        fs.readFileSync(copy, 'utf8'),
        'v2'
    )
    check(
        `${protocol}: copy overwritten in place`,
        fs.lstatSync(copy, { bigint: true }).ino,
        ino
    )
}

fs.rmSync(base, { recursive: true, force: true })
