import * as vscode from "vscode"
import {findNodeAtLocation, parseTree} from "jsonc-parser"

const executionSettings = ["jupytextSync.pythonExecutable", "jupytextSync.setFormatsArgs", "jupytextSync.syncArgs"]
const migrationNoticeKey = "jupytextSync.executionSettingsMigrationNoticeShown"
const migrationGuide = vscode.Uri.parse(
  "https://github.com/jupytext/vscode-jupytext#workspace-trust-and-settings-migration",
)

async function readIgnoredSettings(uri: vscode.Uri, settingsPath: string[]): Promise<string[]> {
  let contents: Uint8Array
  try {
    contents = await vscode.workspace.fs.readFile(uri)
  } catch {
    return []
  }
  // VS Code filters out machine-scoped values before the extension can inspect them.
  const tree = parseTree(Buffer.from(contents).toString("utf8"), undefined, {allowTrailingComma: true})
  if (!tree) {
    return []
  }
  return executionSettings.filter((key) => findNodeAtLocation(tree, [...settingsPath, key]) !== undefined)
}

export async function warnAboutIgnoredWorkspaceSettings(workspaceState: vscode.Memento): Promise<void> {
  if (workspaceState.get<boolean>(migrationNoticeKey)) {
    return
  }

  const folderSettings = (vscode.workspace.workspaceFolders ?? []).map((folder) =>
    readIgnoredSettings(vscode.Uri.joinPath(folder.uri, ".vscode", "settings.json"), []),
  )
  const workspaceFile = vscode.workspace.workspaceFile
  if (workspaceFile && workspaceFile.scheme !== "untitled") {
    folderSettings.push(readIgnoredSettings(workspaceFile, ["settings"]))
  }
  const ignoredSettings = new Set((await Promise.all(folderSettings)).flat())
  if (!ignoredSettings.size) {
    return
  }

  await workspaceState.update(migrationNoticeKey, true)
  void vscode.window.showWarningMessage(
    `Jupytext Sync ignored these workspace settings (${[...ignoredSettings].join(", ")}). ` +
      "Review them before moving any to User or Remote User settings.",
    "Migration Guide",
  ).then((choice) => {
    if (choice === "Migration Guide") {
      return vscode.env.openExternal(migrationGuide)
    }
  })
}
