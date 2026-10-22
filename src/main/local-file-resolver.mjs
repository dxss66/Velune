import fs from "node:fs";
import path from "node:path";

export const LOCAL_FILE_MISSING_ERROR_CODE = "VELUNE_LOCAL_FILE_MISSING";

const DEFAULT_SEARCH_ENTRY_LIMIT = 8_000;

export async function resolveExistingLocalPath(value, options = {}) {
  const requestedPath = path.resolve(String(value || ""));
  const expectedType = options.expectedType === "directory" ? "directory" : options.expectedType === "any" ? "any" : "file";
  const candidates = await localPathRecoveryCandidates(requestedPath, options);
  let exactType = null;

  for (const candidate of candidates) {
    const stats = await statPath(candidate.path);
    if (!stats) continue;
    if (candidate.strategy === "exact") exactType = pathType(stats);
    if (!matchesExpectedType(stats, expectedType)) continue;
    return {
      path: candidate.path,
      originalPath: requestedPath,
      recovered: candidate.strategy !== "exact",
      strategy: candidate.strategy,
      stats,
    };
  }

  if (exactType) {
    throw localFileTypeError(requestedPath, expectedType, exactType);
  }

  const artifactRelativePath = outputsRelativePath(requestedPath);
  if (artifactRelativePath) {
    const matches = await findUniqueArtifactMatch(path.basename(requestedPath), {
      ...options,
      requestedPath,
      expectedType,
    });
    if (matches.length === 1) {
      const match = matches[0];
      return {
        path: match.path,
        originalPath: requestedPath,
        recovered: true,
        strategy: "unique-artifact-name",
        stats: match.stats,
      };
    }
  }

  throw localFileMissingError(requestedPath);
}

export function managedThreadGroupRelativePath(value) {
  const normalized = slashPath(value);
  const marker = "/thread-groups/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  return safeRelativePath(normalized.slice(markerIndex + marker.length));
}

export function outputsRelativePath(value) {
  const normalized = slashPath(value);
  const marker = "/outputs/";
  const markerIndex = normalized.toLowerCase().lastIndexOf(marker);
  if (markerIndex < 0) return null;
  return safeRelativePath(normalized.slice(markerIndex + marker.length));
}

async function localPathRecoveryCandidates(requestedPath, options) {
  const candidates = [];
  const seen = new Set();
  const add = (candidatePath, strategy) => {
    if (!candidatePath) return;
    const resolved = path.resolve(candidatePath);
    const key = normalizePathKey(resolved);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: resolved, strategy });
  };

  add(requestedPath, "exact");

  const managedRoot = managedWorkspacesRoot(options);
  const managedRelative = managedThreadGroupRelativePath(requestedPath);
  if (managedRoot && managedRelative) {
    add(path.join(managedRoot, managedRelative), "managed-workspace-rebase");
  }

  const artifactRelative = outputsRelativePath(requestedPath);
  const cwd = cleanAbsolutePath(options.cwd);
  if (artifactRelative && cwd) {
    add(path.join(cwd, "outputs", artifactRelative), "current-workspace-rebase");
  }

  if (artifactRelative && managedRoot) {
    for (const workspaceRoot of await managedWorkspaceRoots(managedRoot)) {
      add(path.join(workspaceRoot, "outputs", artifactRelative), "managed-artifact-rebase");
    }
  }

  return candidates;
}

async function findUniqueArtifactMatch(fileName, options) {
  if (!fileName) return [];
  const roots = [];
  const seenRoots = new Set();
  const addRoot = (root) => {
    if (!root) return;
    const resolved = path.resolve(root);
    const key = normalizePathKey(resolved);
    if (seenRoots.has(key)) return;
    seenRoots.add(key);
    roots.push(resolved);
  };
  const cwd = cleanAbsolutePath(options.cwd);
  if (cwd) addRoot(path.join(cwd, "outputs"));
  const managedRoot = managedWorkspacesRoot(options);
  if (managedRoot) {
    for (const workspaceRoot of await managedWorkspaceRoots(managedRoot)) {
      addRoot(path.join(workspaceRoot, "outputs"));
    }
  }

  const targetName = normalizeFileName(fileName);
  const maxEntries = Math.max(100, Number(options.searchEntryLimit) || DEFAULT_SEARCH_ENTRY_LIMIT);
  const matches = [];
  const seenMatches = new Set();
  let visited = 0;
  for (const root of roots) {
    const stack = [root];
    while (stack.length && visited < maxEntries && matches.length < 2) {
      const directory = stack.pop();
      let entries;
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > maxEntries) break;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile() || normalizeFileName(entry.name) !== targetName) continue;
        const key = normalizePathKey(entryPath);
        if (seenMatches.has(key)) continue;
        const stats = await statPath(entryPath);
        if (!stats || !matchesExpectedType(stats, options.expectedType)) continue;
        seenMatches.add(key);
        matches.push({ path: entryPath, stats });
        if (matches.length >= 2) break;
      }
    }
    if (visited >= maxEntries || matches.length >= 2) break;
  }
  return matches;
}

async function managedWorkspaceRoots(managedRoot) {
  let entries;
  try {
    entries = await fs.promises.readdir(managedRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(managedRoot, entry.name));
}

function managedWorkspacesRoot(options) {
  const explicit = cleanAbsolutePath(options.managedWorkspacesRoot);
  if (explicit) return explicit;
  const userDataPath = cleanAbsolutePath(options.userDataPath);
  return userDataPath ? path.join(userDataPath, "thread-groups") : null;
}

async function statPath(filePath) {
  try {
    return await fs.promises.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

function matchesExpectedType(stats, expectedType) {
  if (expectedType === "any") return stats.isFile() || stats.isDirectory();
  if (expectedType === "directory") return stats.isDirectory();
  return stats.isFile();
}

function pathType(stats) {
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

function localFileMissingError(filePath) {
  const name = path.basename(filePath) || "该文件";
  const error = new Error(
    `本地文件“${name}”不存在。已检查原路径、当前工作区和成果目录；它可能未实际生成、已被移动或清理，或来自另一台设备。请重新生成或重新发送文件。`,
  );
  error.code = LOCAL_FILE_MISSING_ERROR_CODE;
  error.path = filePath;
  return error;
}

function localFileTypeError(filePath, expectedType, actualType) {
  const expectedLabel = expectedType === "directory" ? "文件夹" : expectedType === "file" ? "文件" : "文件或文件夹";
  const actualLabel = actualType === "directory" ? "文件夹" : actualType === "file" ? "文件" : "不支持的路径类型";
  const error = new Error(`“${path.basename(filePath) || filePath}”是${actualLabel}，不是可用的${expectedLabel}。`);
  error.code = "VELUNE_LOCAL_FILE_TYPE_MISMATCH";
  error.path = filePath;
  return error;
}

function safeRelativePath(value) {
  const segments = slashPath(value)
    .split("/")
    .filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  return path.join(...segments);
}

function slashPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function cleanAbsolutePath(value) {
  const text = String(value || "").trim();
  return text ? path.resolve(text) : null;
}

function normalizePathKey(value) {
  const normalized = path.resolve(String(value || "")).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeFileName(value) {
  const text = String(value || "");
  return process.platform === "win32" ? text.toLowerCase() : text;
}
