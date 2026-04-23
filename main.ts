import { execFile } from "child_process";
import { RangeSetBuilder, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  App,
  FileSystemAdapter,
  MarkdownFileInfo,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  WorkspaceLeaf,
  editorInfoField
} from "obsidian";
import { buildEditorLineDiff, markEntireFile, type EditorLineDiff, type EditorLineStatus } from "./src/editor-diff";
import {
  applyPorcelainRecord,
  buildFolderStatuses,
  getVaultPrefix,
  normalizeLogicalPath,
  parsePorcelainRecords,
  type GitUiStatus
} from "./src/status-model";

type SnapshotAvailability = "ready" | "no-repo" | "git-unavailable" | "error";
type UnavailableSnapshot = Exclude<SnapshotAvailability, "ready">;

interface GitFileColorsSettings {
  fileColoring: boolean;
  folderColoring: boolean;
  editorLineMarkers: boolean;
  newColor: string;
  modifiedColor: string;
  deletedColor: string;
  refreshIntervalMs: number;
}

interface GitSnapshot {
  availability: SnapshotAvailability;
  files: Map<string, GitUiStatus>;
  folders: Map<string, GitUiStatus>;
  error: string | null;
}

interface GitEditorDiffSnapshot {
  availability: SnapshotAvailability;
  diff: EditorLineDiff;
  error: string | null;
}

interface GitEditorBaseSnapshot {
  availability: SnapshotAvailability;
  baseType: "tracked" | "new";
  baseText: string;
  error: string | null;
}

const DEFAULT_SETTINGS: GitFileColorsSettings = {
  fileColoring: true,
  folderColoring: true,
  editorLineMarkers: true,
  newColor: "#6bbf7d",
  modifiedColor: "#c8a15a",
  deletedColor: "#d16b6b",
  refreshIntervalMs: 15000
};

const MIN_REFRESH_INTERVAL_MS = 5000;
const REFRESH_DEBOUNCE_MS = 200;
const DOM_SYNC_DEBOUNCE_MS = 50;
const STATUS_CLASSES = ["ogfc-status-new", "ogfc-status-modified", "ogfc-status-deleted"];
const FILE_EXPLORER_PATH_SELECTOR = [
  ".tree-item[data-path]",
  ".tree-item-self[data-path]",
  ".nav-file-title[data-path]",
  ".nav-folder-title[data-path]"
].join(", ");

export default class GitFileExplorerColorsPlugin extends Plugin {
  settings: GitFileColorsSettings = DEFAULT_SETTINGS;
  private snapshot: GitSnapshot = createEmptySnapshot("no-repo");
  private provider = new GitStatusProvider(() => this.getVaultBasePath());
  private observerByLeaf = new Map<WorkspaceLeaf, MutationObserver>();
  private editorDiffRefreshers = new Set<() => void>();
  private refreshIntervalId: number | null = null;
  private refreshTimeoutId: number | null = null;
  private domSyncTimeoutId: number | null = null;
  private refreshInFlight = false;
  private refreshQueued = false;
  private noticeQueued = false;
  private lastAutomaticNoticeKey: string | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.applyCssVariables();
    this.registerEditorExtension(createEditorDiffExtension(this));

    this.addCommand({
      id: "refresh-git-colors",
      name: "Refresh colors",
      callback: () => {
        void this.refreshAll("manual", { showNotice: true });
      }
    });

    this.addSettingTab(new GitFileColorsSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        this.syncExplorerObservers();
        this.scheduleDomSync();
      })
    );

    this.app.workspace.onLayoutReady(() => {
      this.registerEvent(this.app.vault.on("create", () => this.scheduleRefresh("vault create")));
      this.registerEvent(this.app.vault.on("modify", () => this.scheduleRefresh("vault modify")));
      this.registerEvent(this.app.vault.on("rename", () => this.scheduleRefresh("vault rename")));
      this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh("vault delete")));
      this.syncExplorerObservers();
      void this.refreshAll("plugin load");
    });

    this.restartRefreshTimer();
  }

  onunload(): void {
    if (this.refreshIntervalId !== null) {
      window.clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    if (this.refreshTimeoutId !== null) {
      window.clearTimeout(this.refreshTimeoutId);
      this.refreshTimeoutId = null;
    }

    if (this.domSyncTimeoutId !== null) {
      window.clearTimeout(this.domSyncTimeoutId);
      this.domSyncTimeoutId = null;
    }

    this.disconnectExplorerObservers();
    this.clearExplorerClasses();
    this.clearCssVariables();
  }

  async loadSettings(): Promise<void> {
    const saved = await this.loadData();
    this.settings = normalizeSettings(saved);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyCssVariables();
    this.restartRefreshTimer();
    this.refreshEditorDiffs();
  }

  async updateSettings(
    updater: Partial<GitFileColorsSettings>,
    refreshMode: "dom" | "full" = "dom"
  ): Promise<void> {
    this.settings = normalizeSettings({
      ...this.settings,
      ...updater
    });

    await this.saveSettings();

    if (refreshMode === "full") {
      this.scheduleRefresh("settings update");
      return;
    }

    this.scheduleDomSync();
  }

  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) {
      return adapter.getBasePath();
    }

    return null;
  }

  private scheduleRefresh(reason: string): void {
    if (this.refreshTimeoutId !== null) {
      window.clearTimeout(this.refreshTimeoutId);
    }

    this.refreshTimeoutId = window.setTimeout(() => {
      this.refreshTimeoutId = null;
      void this.refreshAll(reason);
    }, REFRESH_DEBOUNCE_MS);
  }

  private scheduleDomSync(): void {
    if (this.domSyncTimeoutId !== null) {
      window.clearTimeout(this.domSyncTimeoutId);
    }

    this.domSyncTimeoutId = window.setTimeout(() => {
      this.domSyncTimeoutId = null;
      this.applySnapshotToExplorers();
    }, DOM_SYNC_DEBOUNCE_MS);
  }

  private restartRefreshTimer(): void {
    if (this.refreshIntervalId !== null) {
      window.clearInterval(this.refreshIntervalId);
      this.refreshIntervalId = null;
    }

    if (this.settings.refreshIntervalMs <= 0) {
      return;
    }

    this.refreshIntervalId = window.setInterval(() => {
      void this.refreshAll("interval");
    }, this.settings.refreshIntervalMs);
  }

  private async refreshAll(reason: string, options?: { showNotice?: boolean }): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      this.noticeQueued = this.noticeQueued || Boolean(options?.showNotice);
      return;
    }

    this.refreshInFlight = true;
    let showNotice = Boolean(options?.showNotice);

    try {
      do {
        this.refreshQueued = false;
        const previousSnapshot = this.snapshot;
        const nextSnapshot = await this.provider.readStatus();
        this.snapshot = nextSnapshot;
        this.syncExplorerObservers();
        this.applySnapshotToExplorers();
        this.refreshEditorDiffs();

        if (showNotice) {
          this.showRefreshNotice(nextSnapshot);
        } else {
          this.maybeShowAutomaticIssueNotice(previousSnapshot, nextSnapshot);
        }

        showNotice = this.noticeQueued;
        this.noticeQueued = false;
      } while (this.refreshQueued);
    } catch (error) {
      console.error("[git-file-explorer-colors] refresh failed", reason, error);
      this.snapshot = createEmptySnapshot("error", "Unexpected refresh failure.");
      this.applySnapshotToExplorers();

      if (showNotice) {
        new Notice("Git colors refresh failed.");
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  private showRefreshNotice(snapshot: GitSnapshot): void {
    switch (snapshot.availability) {
      case "ready":
        new Notice("Git colors refreshed.");
        return;
      case "no-repo":
        new Notice("Git colors cleared: this vault is not in a Git repo.");
        return;
      case "git-unavailable":
        new Notice("Git colors cleared: Git is not available to the plugin.");
        return;
      case "error":
        new Notice(snapshot.error ?? "Git colors refresh failed.");
        return;
    }
  }

  private maybeShowAutomaticIssueNotice(previousSnapshot: GitSnapshot, nextSnapshot: GitSnapshot): void {
    if (nextSnapshot.availability === "ready") {
      this.lastAutomaticNoticeKey = null;
      return;
    }

    const nextNoticeKey = `${nextSnapshot.availability}:${nextSnapshot.error ?? ""}`;
    const previousNoticeKey = `${previousSnapshot.availability}:${previousSnapshot.error ?? ""}`;

    if (nextNoticeKey === previousNoticeKey || nextNoticeKey === this.lastAutomaticNoticeKey) {
      return;
    }

    this.lastAutomaticNoticeKey = nextNoticeKey;
    new Notice(getAutomaticIssueNoticeMessage(nextSnapshot), 12000);
  }

  private applyCssVariables(): void {
    const root = document.body;
    root.style.setProperty("--ogfc-color-new", this.settings.newColor);
    root.style.setProperty("--ogfc-color-modified", this.settings.modifiedColor);
    root.style.setProperty("--ogfc-color-deleted", this.settings.deletedColor);
  }

  private clearCssVariables(): void {
    const root = document.body;
    root.style.removeProperty("--ogfc-color-new");
    root.style.removeProperty("--ogfc-color-modified");
    root.style.removeProperty("--ogfc-color-deleted");
  }

  private syncExplorerObservers(): void {
    const liveLeaves = new Set(this.app.workspace.getLeavesOfType("file-explorer"));

    for (const [leaf, observer] of this.observerByLeaf.entries()) {
      if (liveLeaves.has(leaf)) {
        continue;
      }

      observer.disconnect();
      this.observerByLeaf.delete(leaf);
    }

    for (const leaf of liveLeaves) {
      if (this.observerByLeaf.has(leaf)) {
        continue;
      }

      const containerEl = leaf.view.containerEl;
      if (!containerEl) {
        continue;
      }

      const observer = new MutationObserver(() => {
        this.scheduleDomSync();
      });

      observer.observe(containerEl, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["data-path", "class"]
      });

      this.observerByLeaf.set(leaf, observer);
    }
  }

  private disconnectExplorerObservers(): void {
    for (const observer of this.observerByLeaf.values()) {
      observer.disconnect();
    }

    this.observerByLeaf.clear();
  }

  private clearExplorerClasses(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const containerEl = leaf.view.containerEl;
      if (containerEl) {
        clearStatusClasses(containerEl);
      }
    }
  }

  private applySnapshotToExplorers(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("file-explorer")) {
      const containerEl = leaf.view.containerEl;
      if (!containerEl) {
        continue;
      }

      clearStatusClasses(containerEl);

      if (this.settings.fileColoring) {
        applyStatusesToElements(containerEl, FILE_EXPLORER_PATH_SELECTOR, this.snapshot.files);
      }

      if (this.settings.folderColoring) {
        applyStatusesToElements(containerEl, FILE_EXPLORER_PATH_SELECTOR, this.snapshot.folders);
      }
    }
  }

  async readEditorBase(filePath: string): Promise<GitEditorBaseSnapshot> {
    return this.provider.readEditorBase(filePath);
  }

  registerEditorDiffRefresher(refresher: () => void): () => void {
    this.editorDiffRefreshers.add(refresher);
    return () => {
      this.editorDiffRefreshers.delete(refresher);
    };
  }

  private refreshEditorDiffs(): void {
    for (const refresher of this.editorDiffRefreshers) {
      refresher();
    }
  }
}

class GitStatusProvider {
  constructor(private readonly getVaultBasePath: () => string | null) {}

  async readStatus(): Promise<GitSnapshot> {
    const vaultBasePath = this.getVaultBasePath();
    if (!vaultBasePath) {
      return createEmptySnapshot("error", "Vault path is unavailable.");
    }

    const repoInfo = await this.resolveRepoInfo(vaultBasePath);
    if (repoInfo.availability !== "ready") {
      return createEmptySnapshot(repoInfo.availability, repoInfo.error);
    }

    const { repoRoot, vaultPrefix } = repoInfo;

    try {
      // Use "all" so Git expands untracked directories into individual files.
      // That lets folder rollups behave like Zed for brand-new folders.
      const output = await runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], repoRoot);
      const files = new Map<string, GitUiStatus>();
      const records = parsePorcelainRecords(output);

      for (const record of records) {
        applyPorcelainRecord(files, record, vaultPrefix);
      }

      return {
        availability: "ready",
        files,
        folders: buildFolderStatuses(files),
        error: null
      };
    } catch (error) {
      return snapshotFromGitFailure(error);
    }
  }

  async readEditorBase(filePath: string): Promise<GitEditorBaseSnapshot> {
    const normalizedFilePath = normalizeLogicalPath(filePath);
    if (!normalizedFilePath) {
      return createEmptyEditorBaseSnapshot("error", "tracked", "File path is unavailable.");
    }

    const vaultBasePath = this.getVaultBasePath();
    if (!vaultBasePath) {
      return createEmptyEditorBaseSnapshot("error", "tracked", "Vault path is unavailable.");
    }

    const repoInfo = await this.resolveRepoInfo(vaultBasePath);
    if (repoInfo.availability !== "ready") {
      return createEmptyEditorBaseSnapshot(repoInfo.availability, "tracked", repoInfo.error);
    }

    const { repoRoot, vaultPrefix } = repoInfo;
    const repoRelativePath = toRepoRelativePath(normalizedFilePath, vaultPrefix);

    try {
      const output = await runGit(["show", `HEAD:${repoRelativePath}`], repoRoot);

      return {
        availability: "ready",
        baseType: "tracked",
        baseText: normalizeEditorText(output.toString("utf8")),
        error: null
      };
    } catch (error) {
      if (isMissingEditorBaseFailure(error)) {
        return createEmptyEditorBaseSnapshot("ready", "new");
      }

      const info = snapshotInfoFromGitFailure(error);
      return createEmptyEditorBaseSnapshot(info.availability, "tracked", info.error);
    }
  }

  private async resolveRepoInfo(
    vaultBasePath: string
  ): Promise<
    | { availability: "ready"; repoRoot: string; vaultPrefix: string }
    | { availability: UnavailableSnapshot; error: string | null }
  > {
    try {
      const output = await runGit(["rev-parse", "--show-toplevel"], vaultBasePath);
      const repoRoot = output.toString("utf8").trim().replace(/\\/g, "/");
      const vaultPrefix = getVaultPrefix(repoRoot, vaultBasePath);

      if (vaultPrefix === null) {
        return {
          availability: "error",
          error: "Vault path is outside the resolved Git root."
        };
      }

      return {
        availability: "ready",
        repoRoot,
        vaultPrefix
      };
    } catch (error) {
      return snapshotInfoFromGitFailure(error);
    }
  }
}

class GitFileColorsSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: GitFileExplorerColorsPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Color file rows")
      .setDesc("Apply Git colors to file rows in the File Explorer.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.fileColoring).onChange(async (value) => {
          await this.plugin.updateSettings({ fileColoring: value });
        });
      });

    new Setting(containerEl)
      .setName("Color folder rows")
      .setDesc("Roll descendant Git changes up to folders using deleted > modified > new priority.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.folderColoring).onChange(async (value) => {
          await this.plugin.updateSettings({ folderColoring: value });
        });
      });

    new Setting(containerEl)
      .setName("Show editor line markers")
      .setDesc("Highlight added, modified, and deleted lines in the Markdown editor.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.editorLineMarkers).onChange(async (value) => {
          await this.plugin.updateSettings({ editorLineMarkers: value });
        });
      });

    this.addColorSetting(
      containerEl,
      "New color",
      "Used for untracked and newly added files.",
      this.plugin.settings.newColor,
      async (value) => {
        await this.plugin.updateSettings({ newColor: normalizeColorValue(value, DEFAULT_SETTINGS.newColor) });
      }
    );

    this.addColorSetting(
      containerEl,
      "Modified color",
      "Used for tracked files with content or metadata changes.",
      this.plugin.settings.modifiedColor,
      async (value) => {
        await this.plugin.updateSettings({
          modifiedColor: normalizeColorValue(value, DEFAULT_SETTINGS.modifiedColor)
        });
      }
    );

    this.addColorSetting(
      containerEl,
      "Deleted color",
      "Used for deleted file signals and affected parent folders.",
      this.plugin.settings.deletedColor,
      async (value) => {
        await this.plugin.updateSettings({
          deletedColor: normalizeColorValue(value, DEFAULT_SETTINGS.deletedColor)
        });
      }
    );

    new Setting(containerEl)
      .setName("Refresh interval")
      .setDesc("Fallback polling interval in seconds for external Git changes.")
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(MIN_REFRESH_INTERVAL_MS / 1000);
        text.inputEl.step = "1";
        text.setValue(String(Math.round(this.plugin.settings.refreshIntervalMs / 1000)));
        text.onChange(async (value) => {
          const nextSeconds = Number.parseInt(value, 10);
          const nextMs = Number.isFinite(nextSeconds)
            ? nextSeconds * 1000
            : this.plugin.settings.refreshIntervalMs;
          await this.plugin.updateSettings({ refreshIntervalMs: nextMs }, "full");
        });
      });
  }

  private addColorSetting(
    containerEl: HTMLElement,
    name: string,
    description: string,
    currentValue: string,
    onChange: (value: string) => Promise<void>
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text.inputEl.type = "color";
        text.setValue(normalizeColorValue(currentValue, currentValue));
        text.onChange(async (value) => {
          await onChange(value);
        });
      });
  }
}

function createEmptySnapshot(
  availability: SnapshotAvailability,
  error: string | null = null
): GitSnapshot {
  return {
    availability,
    files: new Map<string, GitUiStatus>(),
    folders: new Map<string, GitUiStatus>(),
    error
  };
}

function createEmptyEditorDiffSnapshot(
  availability: SnapshotAvailability,
  error: string | null = null
): GitEditorDiffSnapshot {
  return {
    availability,
    diff: {
      lineStatuses: new Map<number, EditorLineStatus>(),
      deletedAnchors: []
    },
    error
  };
}

function createEmptyEditorBaseSnapshot(
  availability: SnapshotAvailability,
  baseType: "tracked" | "new",
  error: string | null = null
): GitEditorBaseSnapshot {
  return {
    availability,
    baseType,
    baseText: "",
    error
  };
}

function normalizeSettings(input: unknown): GitFileColorsSettings {
  const data = typeof input === "object" && input !== null ? (input as Partial<GitFileColorsSettings>) : {};

  return {
    fileColoring: data.fileColoring ?? DEFAULT_SETTINGS.fileColoring,
    folderColoring: data.folderColoring ?? DEFAULT_SETTINGS.folderColoring,
    editorLineMarkers: data.editorLineMarkers ?? DEFAULT_SETTINGS.editorLineMarkers,
    newColor: normalizeColorValue(data.newColor ?? DEFAULT_SETTINGS.newColor, DEFAULT_SETTINGS.newColor),
    modifiedColor: normalizeColorValue(
      data.modifiedColor ?? DEFAULT_SETTINGS.modifiedColor,
      DEFAULT_SETTINGS.modifiedColor
    ),
    deletedColor: normalizeColorValue(
      data.deletedColor ?? DEFAULT_SETTINGS.deletedColor,
      DEFAULT_SETTINGS.deletedColor
    ),
    refreshIntervalMs: clampRefreshInterval(data.refreshIntervalMs ?? DEFAULT_SETTINGS.refreshIntervalMs)
  };
}

function clampRefreshInterval(value: unknown): number {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return DEFAULT_SETTINGS.refreshIntervalMs;
  }

  return Math.max(MIN_REFRESH_INTERVAL_MS, Math.round(numericValue));
}

function normalizeColorValue(value: string, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return /^#[\da-fA-F]{6}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeEditorText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function toRepoRelativePath(vaultRelativePath: string, vaultPrefix: string): string {
  if (!vaultPrefix) {
    return vaultRelativePath;
  }

  return `${vaultPrefix}/${vaultRelativePath}`;
}

async function runGit(args: string[], cwd: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: createGitEnv(),
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? "");
        const stderrBuffer = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? "");

        if (error) {
          reject(
            new GitCommandFailure(
              error,
              stdoutBuffer.toString("utf8"),
              stderrBuffer.toString("utf8")
            )
          );
          return;
        }

        resolve(stdoutBuffer);
      }
    );
  });
}

function createGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env
  };

  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_INDEX_VERSION;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_PREFIX;
  delete env.GIT_CEILING_DIRECTORIES;

  return env;
}

function clearStatusClasses(containerEl: HTMLElement): void {
  const elements = containerEl.querySelectorAll<HTMLElement>(
    STATUS_CLASSES.map((statusClass) => `.${statusClass}`).join(", ")
  );

  elements.forEach((element) => {
    element.classList.remove(...STATUS_CLASSES);
  });
}

function applyStatusesToElements(
  containerEl: HTMLElement,
  selector: string,
  statuses: Map<string, GitUiStatus>
): void {
  const elements = containerEl.querySelectorAll<HTMLElement>(selector);

  elements.forEach((element) => {
    const dataPath = element.getAttribute("data-path");
    if (!dataPath) {
      return;
    }

    const status = statuses.get(normalizeLogicalPath(dataPath));
    if (!status) {
      return;
    }

    addStatusClass(element, status);
  });
}

function addStatusClass(element: HTMLElement, status: GitUiStatus): void {
  const statusClass = `ogfc-status-${status}`;
  const targets = new Set<HTMLElement>();
  const row = resolveStatusRow(element);

  targets.add(row);
  row
    .querySelectorAll<HTMLElement>(".tree-item-inner, .nav-file-title-content, .nav-folder-title-content")
    .forEach((target) => {
      targets.add(target);
    });

  targets.forEach((target) => {
    target.classList.add(statusClass);
  });
}

function resolveStatusRow(element: HTMLElement): HTMLElement {
  if (element.matches(".tree-item-self")) {
    return element;
  }

  if (element.matches(".tree-item")) {
    const directRow = element.querySelector<HTMLElement>(":scope > .tree-item-self");
    if (directRow) {
      return directRow;
    }
  }

  return element.closest<HTMLElement>(".tree-item-self") ?? element;
}

function snapshotInfoFromGitFailure(
  error: unknown
): { availability: UnavailableSnapshot; error: string | null } {
  if (isGitCommandFailure(error)) {
    if (error.codeValue === "ENOENT") {
      return {
        availability: "git-unavailable",
        error: "Git executable not found."
      };
    }

    if (error.stderr.includes("not a git repository")) {
      return {
        availability: "no-repo",
        error: null
      };
    }

    return {
      availability: "error",
      error: normalizeGitFailureMessage(error.stderr || error.message)
    };
  }

  return {
    availability: "error",
    error: normalizeGitFailureMessage(error instanceof Error ? error.message : "Unknown Git error.")
  };
}

function snapshotFromGitFailure(
  error: unknown
): GitSnapshot {
  const info = snapshotInfoFromGitFailure(error);
  if (info.availability === "error") {
    console.error("[git-file-explorer-colors] Git command failed", error);
  }

  return createEmptySnapshot(info.availability, info.error);
}

function isGitCommandFailure(error: unknown): error is GitCommandFailure {
  return error instanceof GitCommandFailure;
}

function isMissingEditorBaseFailure(error: unknown): boolean {
  if (!isGitCommandFailure(error)) {
    return false;
  }

  const stderr = (error.stderr || error.message).toLowerCase();

  return (
    stderr.includes("invalid object name 'head'") ||
    stderr.includes("bad revision 'head'") ||
    stderr.includes("unknown revision or path not in the working tree") ||
    stderr.includes("does not exist in 'head'") ||
    stderr.includes("exists on disk, but not in 'head'")
  );
}

function getAutomaticIssueNoticeMessage(snapshot: GitSnapshot): string {
  switch (snapshot.availability) {
    case "git-unavailable":
      return "Git File Explorer Colors: Git is not available to Obsidian on this machine.";
    case "no-repo":
      return "Git File Explorer Colors: this vault is not inside a Git repository.";
    case "error":
      return snapshot.error ?? "Git File Explorer Colors could not read Git status.";
    case "ready":
      return "Git colors refreshed.";
  }
}

function normalizeGitFailureMessage(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) {
    return "Git command failed.";
  }

  const normalized = trimmed.toLowerCase();

  if (
    normalized.includes("xcode license") ||
    normalized.includes("agree to the xcode") ||
    normalized.includes("license agreements")
  ) {
    return "Git File Explorer Colors needs the Xcode license accepted. Open Terminal and run: sudo xcodebuild -license accept";
  }

  if (
    normalized.includes("xcode-select") ||
    normalized.includes("command line developer tools") ||
    normalized.includes("developer tools were found")
  ) {
    return "Git File Explorer Colors needs Apple's Command Line Tools. Open Terminal and run: xcode-select --install";
  }

  return trimmed;
}

class GitCommandFailure extends Error {
  readonly codeValue: number | string | undefined;
  readonly stdout: string;
  readonly stderr: string;

  constructor(error: Error & { code?: string | number }, stdout: string, stderr: string) {
    super(stderr || error.message || "Git command failed.");
    this.name = "GitCommandFailure";
    this.codeValue = error.code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

const setEditorDiffEffect = StateEffect.define<GitEditorDiffSnapshot>();
const editorDiffField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setEditorDiffEffect)) {
        return buildEditorDiffDecorations(transaction.state, effect.value.diff);
      }
    }

    if (transaction.docChanged) {
      return decorations.map(transaction.changes);
    }

    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function createEditorDiffExtension(plugin: GitFileExplorerColorsPlugin): Extension {
  return [
    editorDiffField,
    ViewPlugin.fromClass(
      class GitEditorDiffView {
        private removeRefresher: (() => void) | null = null;
        private refreshTimeoutId: number | null = null;
        private refreshRequestId = 0;
        private currentFilePath: string | null = null;
        private baseSnapshot: GitEditorBaseSnapshot | null = null;

        constructor(private readonly view: EditorView) {
          this.removeRefresher = plugin.registerEditorDiffRefresher(() => {
            this.scheduleBaseRefresh(0);
          });
          this.currentFilePath = getEditorFilePath(view);
          this.scheduleBaseRefresh(0);
        }

        update(update: ViewUpdate): void {
          const nextFilePath = getEditorFilePath(update.view);
          const fileChanged = nextFilePath !== this.currentFilePath;

          if (fileChanged) {
            this.currentFilePath = nextFilePath;
          }

          if (fileChanged) {
            this.scheduleBaseRefresh(0);
            return;
          }

          if (update.docChanged) {
            this.scheduleRender(0);
          }
        }

        destroy(): void {
          if (this.refreshTimeoutId !== null) {
            window.clearTimeout(this.refreshTimeoutId);
            this.refreshTimeoutId = null;
          }

          this.removeRefresher?.();
        }

        private scheduleBaseRefresh(delayMs: number): void {
          if (this.refreshTimeoutId !== null) {
            window.clearTimeout(this.refreshTimeoutId);
          }

          this.refreshTimeoutId = window.setTimeout(() => {
            this.refreshTimeoutId = null;
            void this.refreshBase();
          }, delayMs);
        }

        private scheduleRender(delayMs: number): void {
          if (this.refreshTimeoutId !== null) {
            window.clearTimeout(this.refreshTimeoutId);
          }

          this.refreshTimeoutId = window.setTimeout(() => {
            this.refreshTimeoutId = null;
            this.renderCurrentDiff();
          }, delayMs);
        }

        private async refreshBase(): Promise<void> {
          const filePath = getEditorFilePath(this.view);
          const requestId = ++this.refreshRequestId;

          if (!plugin.settings.editorLineMarkers || !filePath) {
            this.baseSnapshot = null;
            this.dispatchDiff(createEmptyEditorDiffSnapshot("ready"));
            return;
          }

          const baseSnapshot = await plugin.readEditorBase(filePath);
          if (requestId !== this.refreshRequestId) {
            return;
          }

          this.baseSnapshot = baseSnapshot;
          this.renderCurrentDiff();
        }

        private renderCurrentDiff(): void {
          if (!plugin.settings.editorLineMarkers || !this.currentFilePath) {
            this.dispatchDiff(createEmptyEditorDiffSnapshot("ready"));
            return;
          }

          if (!this.baseSnapshot) {
            this.dispatchDiff(createEmptyEditorDiffSnapshot("ready"));
            return;
          }

          if (this.baseSnapshot.availability !== "ready") {
            this.dispatchDiff(createEmptyEditorDiffSnapshot(this.baseSnapshot.availability, this.baseSnapshot.error));
            return;
          }

          const diff =
            this.baseSnapshot.baseType === "new"
              ? markEntireFile(this.view.state.doc.lines, "new")
              : buildEditorLineDiff(this.baseSnapshot.baseText, normalizeEditorText(this.view.state.doc.toString()));

          this.dispatchDiff({
            availability: "ready",
            diff,
            error: null
          });
        }

        private dispatchDiff(snapshot: GitEditorDiffSnapshot): void {
          this.view.dispatch({
            effects: setEditorDiffEffect.of(snapshot)
          });
        }
      }
    )
  ];
}

function getEditorFilePath(view: EditorView): string | null {
  const info = view.state.field(editorInfoField, false) as MarkdownFileInfo | undefined;
  return normalizeLogicalPath(info?.file?.path ?? "") || null;
}

function buildEditorDiffDecorations(state: EditorView["state"], diff: EditorLineDiff): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();

  for (const [lineNumber, status] of [...diff.lineStatuses.entries()].sort((a, b) => a[0] - b[0])) {
    if (lineNumber < 1 || lineNumber > state.doc.lines) {
      continue;
    }

    const line = state.doc.line(lineNumber);
    builder.add(line.from, line.from, Decoration.line({ class: getEditorLineClass(status) }));
  }

  if (state.doc.lines <= 0) {
    return builder.finish();
  }

  for (const anchor of diff.deletedAnchors) {
    const line = anchor <= state.doc.lines ? state.doc.line(anchor) : state.doc.line(state.doc.lines);
    builder.add(
      line.from,
      line.from,
      Decoration.widget({
        widget: new DeletedLineMarkerWidget(),
        side: anchor > state.doc.lines ? 1 : -1
      })
    );
  }

  return builder.finish();
}

function getEditorLineClass(status: EditorLineStatus): string {
  return status === "new" ? "ogfc-editor-line-new" : "ogfc-editor-line-modified";
}

class DeletedLineMarkerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const marker = document.createElement("span");
    marker.className = "ogfc-editor-line-deleted-marker";
    marker.setAttribute("aria-hidden", "true");
    return marker;
  }
}
