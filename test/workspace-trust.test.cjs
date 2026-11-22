const assert = require("node:assert/strict")
const {mkdtempSync, readFileSync, existsSync, rmSync} = require("node:fs")
const {tmpdir} = require("node:os")
const path = require("node:path")
const {test} = require("node:test")
const vm = require("node:vm")
const manifest = require("../package.json")

// Load the compiled extension with only VS Code mocked; child processes are real.
function loadExtension(isTrusted, vscodeOverrides = {}) {
  const vscode = {
    workspace: {
      isTrusted,
      getConfiguration() {
        throw new Error("Untrusted discovery must not read configuration")
      },
    },
    ...vscodeOverrides,
  }
  const cache = new Map()
  function load(filename) {
    if (cache.has(filename)) {
      return cache.get(filename)
    }
    const exports = {}
    cache.set(filename, exports)
    vm.runInNewContext(readFileSync(filename, "utf8"), {
      exports,
      Buffer,
      process,
      console,
      require(name) {
        if (name === "vscode") {
          return vscode
        }
        return name.startsWith(".")
          ? load(path.resolve(path.dirname(filename), `${name}.js`))
          : require(name)
      },
    }, {filename})
    return exports
  }
  return {vscode, python: load(path.resolve(__dirname, "../out/python.js")), load}
}

test("execution settings are user-only and restricted by Workspace Trust", () => {
  const keys = ["pythonExecutable", "setFormatsArgs", "syncArgs"].map((key) => `jupytextSync.${key}`)
  for (const key of keys) {
    assert.equal(manifest.contributes.configuration.properties[key].scope, "machine")
  }
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, "limited")
  assert.deepEqual(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations, keys)
})

test("the process boundary blocks execution in Restricted Mode and permits it after trust", async (t) => {
  const {vscode, python} = loadExtension(false)
  const dir = mkdtempSync(path.join(tmpdir(), "jupytext-trust-"))
  t.after(() => rmSync(dir, {recursive: true, force: true}))
  const marker = path.join(dir, "executed")
  const command = [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
  await assert.rejects(python.runCommand(command, dir), /Trust this workspace/)
  assert.equal(existsSync(marker), false)

  vscode.workspace.isTrusted = true
  await python.runCommand(command, dir)
  assert.equal(readFileSync(marker, "utf8"), "ran")

  // Trust is checked for every launch, even when a caller has cached its command.
  vscode.workspace.isTrusted = false
  await assert.rejects(python.runCommand(command, dir), /Trust this workspace/)
})

test("untrusted discovery and sync entry points return before reading configuration", async () => {
  const {load} = loadExtension(false)
  const jupytext = load(path.resolve(__dirname, "../out/jupytext.js"))
  assert.equal(await jupytext.locatePythonAndJupytext(), undefined)
  assert.equal(await jupytext.validatePythonAndJupytext(), undefined)
  assert.equal(await jupytext.ensurePythonAndJupytext(false), undefined)
  assert.equal(await jupytext.ensurePythonAndJupytext(true), undefined)
})

test("migration notices name ignored settings once without copying their values", async () => {
  const files = new Map([
    ["/one/.vscode/settings.json", `{
      // The following setting is a comment, not an override:
      // "jupytextSync.setFormatsArgs": [],
      "jupytextSync.pythonExecutable": "/one/.venv/bin/python",
    }`],
    ["/project.code-workspace", `{
      "settings": {"jupytextSync.syncArgs": ["--sync"], "jupytextSync.pythonExecutable": "python3"},
    }`],
  ])
  const notices = []
  const state = new Map()
  const {load} = loadExtension(true, {
    Uri: {parse: (value) => value, joinPath: (uri, ...segments) => path.posix.join(uri, ...segments)},
    workspace: {
      workspaceFile: "/project.code-workspace",
      workspaceFolders: [{uri: "/one"}, {uri: "/two"}],
      fs: {
        async readFile(uri) {
          const contents = files.get(uri)
          if (contents === undefined) {
            throw new Error("Settings file does not exist")
          }
          return Buffer.from(contents)
        },
      },
    },
    window: {async showWarningMessage(message) { notices.push(message) }},
  })
  const {warnAboutIgnoredWorkspaceSettings} = load(path.resolve(__dirname, "../out/settingsMigration.js"))
  const workspaceState = {get: (key) => state.get(key), update: async (key, value) => state.set(key, value)}
  await warnAboutIgnoredWorkspaceSettings(workspaceState)
  await warnAboutIgnoredWorkspaceSettings(workspaceState)
  assert.equal(notices.length, 1)
  assert.match(notices[0], /jupytextSync\.pythonExecutable, jupytextSync\.syncArgs/)
  assert.doesNotMatch(notices[0], /setFormatsArgs|\.venv|--sync/)
})
