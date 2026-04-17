import * as vscode from 'vscode';

export interface TreeNode {
  name: string;
  relPath: string;          // posix path relative to workspace root, e.g. 'example/functs/hello.js'
  uri: vscode.Uri;
  type: 'file' | 'folder';
  depth: number;            // 0 = direct child of subDir
  children: TreeNode[];     // [] for files; sorted folders-first then alpha for folders
  parent: TreeNode | null;
}

/**
 * In-memory tree of a single workspace subdirectory (e.g. 'example/'), with
 * collapsible folder state and a FileSystemWatcher that rebuilds on
 * create/delete/rename. The synthetic root represents subDir itself and is
 * NOT rendered — its children are the depth-0 visible rows.
 */
export class FileTree {
  private root: TreeNode | null = null;
  private nodesByRelPath = new Map<string, TreeNode>();
  private expanded = new Set<string>();
  private visibleCache: TreeNode[] | null = null;
  private watcher: vscode.FileSystemWatcher | null = null;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private changeEmitter = new vscode.EventEmitter<void>();
  readonly onChange = this.changeEmitter.event;

  constructor(
    private workspaceRoot: vscode.Uri,
    private subDir: string,                  // e.g. 'example'
    private log: vscode.OutputChannel,
  ) {}

  get rootDirName(): string {
    return this.subDir;
  }

  isExpanded(relPath: string): boolean {
    return this.expanded.has(relPath);
  }

  async build(): Promise<void> {
    await this.rebuild();
    this.startWatcher();
  }

  dispose(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    this.watcher?.dispose();
    this.watcher = null;
    this.changeEmitter.dispose();
  }

  // ------------------------------------------------------------------
  // Tree access
  // ------------------------------------------------------------------

  getVisible(): TreeNode[] {
    if (this.visibleCache) return this.visibleCache;
    const out: TreeNode[] = [];
    if (this.root) {
      for (const child of this.root.children) {
        this.flatten(child, out);
      }
    }
    this.visibleCache = out;
    return out;
  }

  getNodeByPath(relPath: string): TreeNode | null {
    return this.nodesByRelPath.get(relPath) ?? null;
  }

  getNodeByUri(uri: vscode.Uri): TreeNode | null {
    const rootStr = this.workspaceRoot.toString();
    const target = uri.toString();
    if (!target.startsWith(rootStr)) return null;
    let rel = target.substring(rootStr.length);
    if (rel.startsWith('/')) rel = rel.substring(1);
    return this.getNodeByPath(rel);
  }

  // ------------------------------------------------------------------
  // Mutation
  // ------------------------------------------------------------------

  toggleFolder(relPath: string): void {
    const node = this.nodesByRelPath.get(relPath);
    if (!node || node.type !== 'folder') return;
    if (this.expanded.has(relPath)) {
      this.expanded.delete(relPath);
    } else {
      this.expanded.add(relPath);
    }
    this.visibleCache = null;
    this.changeEmitter.fire();
  }

  /** Expands every ancestor folder of `relPath` so the node becomes visible. */
  revealFile(relPath: string): boolean {
    const node = this.nodesByRelPath.get(relPath);
    if (!node) return false;
    let changed = false;
    let cur = node.parent;
    while (cur && cur !== this.root) {
      if (!this.expanded.has(cur.relPath)) {
        this.expanded.add(cur.relPath);
        changed = true;
      }
      cur = cur.parent;
    }
    if (changed) {
      this.visibleCache = null;
      this.changeEmitter.fire();
    }
    return changed;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private flatten(node: TreeNode, out: TreeNode[]): void {
    out.push(node);
    if (node.type === 'folder' && this.expanded.has(node.relPath)) {
      for (const child of node.children) {
        this.flatten(child, out);
      }
    }
  }

  private startWatcher(): void {
    const pattern = new vscode.RelativePattern(this.workspaceRoot, `${this.subDir}/**/*`);
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const onFs = () => this.scheduleRebuild();
    this.watcher.onDidCreate(onFs);
    this.watcher.onDidDelete(onFs);
    // onDidChange ignored — content edits don't change the tree shape
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(async () => {
      this.rebuildTimer = null;
      try {
        await this.rebuild();
        this.visibleCache = null;
        this.changeEmitter.fire();
      } catch (err: any) {
        this.log.appendLine(`[FileTree] rebuild error: ${err?.message ?? err}`);
      }
    }, 100);
  }

  private async rebuild(): Promise<void> {
    this.nodesByRelPath.clear();
    const subUri = vscode.Uri.joinPath(this.workspaceRoot, this.subDir);
    const root: TreeNode = {
      name: this.subDir,
      relPath: this.subDir,
      uri: subUri,
      type: 'folder',
      depth: -1,
      children: [],
      parent: null,
    };
    this.nodesByRelPath.set(this.subDir, root);

    let exists = false;
    try {
      const stat = await vscode.workspace.fs.stat(subUri);
      exists = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      exists = false;
    }
    if (exists) {
      await this.scanDir(root, 0);
      this.log.appendLine(`[FileTree] scanned ${subUri.fsPath} → ${root.children.length} top-level entries (${this.nodesByRelPath.size - 1} total)`);
    } else {
      this.log.appendLine(`[FileTree] directory not found: ${subUri.fsPath}`);
    }
    this.root = root;

    // Prune stale expansion entries.
    for (const path of Array.from(this.expanded)) {
      if (!this.nodesByRelPath.has(path)) this.expanded.delete(path);
    }
    this.visibleCache = null;
  }

  private async scanDir(parent: TreeNode, depth: number): Promise<void> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(parent.uri);
    } catch (err: any) {
      this.log.appendLine(`[FileTree] readDirectory failed for ${parent.relPath}: ${err?.message ?? err}`);
      return;
    }

    // Folders first, then files; alpha case-insensitive within each group.
    entries.sort(([na, ta], [nb, tb]) => {
      const aFolder = (ta & vscode.FileType.Directory) !== 0;
      const bFolder = (tb & vscode.FileType.Directory) !== 0;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return na.localeCompare(nb, undefined, { sensitivity: 'base' });
    });

    for (const [name, type] of entries) {
      const isFolder = (type & vscode.FileType.Directory) !== 0;
      const isFile = (type & vscode.FileType.File) !== 0;
      if (!isFolder && !isFile) continue;

      const childRel = `${parent.relPath}/${name}`;
      const childUri = vscode.Uri.joinPath(parent.uri, name);
      const node: TreeNode = {
        name,
        relPath: childRel,
        uri: childUri,
        type: isFolder ? 'folder' : 'file',
        depth,
        children: [],
        parent,
      };
      parent.children.push(node);
      this.nodesByRelPath.set(childRel, node);

      if (isFolder) {
        await this.scanDir(node, depth + 1);
      }
    }
  }
}
