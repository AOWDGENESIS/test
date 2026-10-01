import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync, constants } from "node:fs";
import path from "node:path";

function findGatewayRoot() {
  const configuredRoot = process.env["MCP_WORKSPACE_ROOT"];
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  let candidate = path.resolve(process.cwd());
  while (true) {
    if (existsSync(path.join(candidate, "pnpm-workspace.yaml"))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return path.resolve(process.cwd());
    }
    candidate = parent;
  }
}

const gatewayRoot = findGatewayRoot();

export type ProjectWorkspace = {
  id: string;
  name: string;
  root: string;
};

const sensitiveBasenames = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  "id_rsa",
  "id_ed25519",
]);

const sensitiveExtensions = new Set([".pem", ".key", ".p12", ".pfx"]);

export type WorkspaceEntry = {
  path: string;
  type: "file" | "directory";
  size?: number;
};

export function getGatewayRoot() {
  return gatewayRoot;
}

export function isSensitiveWorkspacePath(relativePath: string) {
  const normalized = relativePath.split(path.sep).join("/");
  const basename = path.posix.basename(normalized);

  return (
    sensitiveBasenames.has(basename) ||
    basename.startsWith(".env.") ||
    sensitiveExtensions.has(path.posix.extname(basename)) ||
    basename.startsWith("id_rsa") ||
    basename.startsWith("id_ed25519")
  );
}

export function isProtectedWorkspacePath(relativePath: string) {
  return (
    relativePath.split(path.sep).join("/") === "config/mcp-projects.json"
  );
}

async function ensureInsideProject(
  project: ProjectWorkspace,
  candidatePath: string,
  allowMissing: boolean,
) {
  const projectRoot = path.resolve(project.root);
  const projectRootWithSeparator = `${projectRoot}${path.sep}`;
  const candidate = path.resolve(candidatePath);

  if (
    candidate !== projectRoot &&
    !candidate.startsWith(projectRootWithSeparator)
  ) {
    throw new Error(`Path must stay inside project "${project.id}".`);
  }

  try {
    const resolved = await realpath(candidate);
    if (
      resolved !== projectRoot &&
      !resolved.startsWith(projectRootWithSeparator)
    ) {
      throw new Error(
        `Symlinked paths outside project "${project.id}" are not allowed.`,
      );
    }
    return resolved;
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    let existingParent = path.dirname(candidate);
    while (
      existingParent !== projectRoot &&
      !existsSync(existingParent)
    ) {
      existingParent = path.dirname(existingParent);
    }
    const parent = await realpath(existingParent);
    if (
      parent !== projectRoot &&
      !parent.startsWith(projectRootWithSeparator)
    ) {
      throw new Error(
        `The target parent directory must stay inside project "${project.id}".`,
      );
    }
    return path.join(parent, path.relative(existingParent, candidate));
  }
}

export async function resolveWorkspacePath(
  project: ProjectWorkspace,
  requestedPath: string,
  options: { allowMissing?: boolean } = {},
) {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw new Error("A non-empty relative project path is required.");
  }
  if (path.isAbsolute(requestedPath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const normalized = path.normalize(requestedPath);
  const relativePath = normalized === "." ? "" : normalized;
  if (isSensitiveWorkspacePath(relativePath)) {
    throw new Error("Access to credential and private-key files is blocked.");
  }

  const absolutePath = await ensureInsideProject(
    project,
    path.join(project.root, relativePath),
    options.allowMissing ?? false,
  );
  return {
    absolutePath,
    relativePath: path.relative(project.root, absolutePath) || ".",
  };
}

export async function listWorkspace(
  project: ProjectWorkspace,
  requestedPath: string,
  recursive: boolean,
  maxEntries: number,
) {
  const resolved = await resolveWorkspacePath(project, requestedPath);
  const rootStats = await stat(resolved.absolutePath);
  const entries: WorkspaceEntry[] = [];

  if (rootStats.isFile()) {
    return [{ path: resolved.relativePath, type: "file", size: rootStats.size }];
  }
  if (!rootStats.isDirectory()) {
    throw new Error("The requested path is not a regular file or directory.");
  }

  async function walk(currentAbsolutePath: string) {
    const children = await readdir(currentAbsolutePath, {
      withFileTypes: true,
    });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (entries.length >= maxEntries) {
        return;
      }
      const childAbsolutePath = path.join(currentAbsolutePath, child.name);
      const childRelativePath = path.relative(
        project.root,
        childAbsolutePath,
      );

      if (
        child.isSymbolicLink() ||
        isSensitiveWorkspacePath(childRelativePath)
      ) {
        continue;
      }

      if (child.isDirectory()) {
        entries.push({ path: childRelativePath, type: "directory" });
        if (recursive) {
          await walk(childAbsolutePath);
        }
      } else if (child.isFile()) {
        const childStats = await stat(childAbsolutePath);
        entries.push({
          path: childRelativePath,
          type: "file",
          size: childStats.size,
        });
      }
    }
  }

  await walk(resolved.absolutePath);
  return entries;
}

export async function readWorkspaceFile(
  project: ProjectWorkspace,
  requestedPath: string,
  maxBytes: number,
) {
  const resolved = await resolveWorkspacePath(project, requestedPath);
  const buffer = await readFile(resolved.absolutePath);
  const truncated = buffer.byteLength > maxBytes;
  const content = buffer.subarray(0, maxBytes).toString("utf8");

  return {
    projectId: project.id,
    path: resolved.relativePath,
    content,
    bytes: buffer.byteLength,
    truncated,
  };
}

export async function writeWorkspaceFile(
  project: ProjectWorkspace,
  requestedPath: string,
  content: string,
  overwrite: boolean,
) {
  const resolved = await resolveWorkspacePath(project, requestedPath, {
    allowMissing: true,
  });
  if (isProtectedWorkspacePath(resolved.relativePath)) {
    throw new Error("The MCP project registry cannot be changed through MCP.");
  }

  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > 1_000_000) {
    throw new Error("Writes are limited to 1 MB per operation.");
  }

  if (!overwrite) {
    try {
      await access(resolved.absolutePath, constants.F_OK);
      throw new Error("The target file already exists; set overwrite to true.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  await mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await writeFile(resolved.absolutePath, content, "utf8");
  return { projectId: project.id, path: resolved.relativePath, bytes };
}