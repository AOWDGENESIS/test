import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getGatewayRoot, type ProjectWorkspace } from "./workspace";

type ProjectConfigEntry = {
  id: string;
  name?: string;
  root: string;
  enabled?: boolean;
};

const projectIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function getConfigPath() {
  const configuredPath = process.env["MCP_PROJECTS_CONFIG"];
  return configuredPath
    ? path.resolve(configuredPath)
    : path.join(getGatewayRoot(), "config", "mcp-projects.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function resolveProjectRoot(root: string) {
  const candidate = path.isAbsolute(root)
    ? root
    : path.resolve(getGatewayRoot(), root);
  const resolved = await realpath(candidate);
  const details = await stat(resolved);
  if (!details.isDirectory()) {
    throw new Error(`Configured project root is not a directory: ${root}`);
  }
  return resolved;
}

export async function loadConfiguredProjects(): Promise<ProjectWorkspace[]> {
  const configPath = getConfigPath();
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to load MCP project registry at ${configPath}: ${
        error instanceof Error ? error.message : "invalid JSON"
      }`,
    );
  }

  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed["projects"])
  ) {
    throw new Error('MCP project registry must contain a "projects" array.');
  }

  const seenIds = new Set<string>();
  const projects: ProjectWorkspace[] = [];

  for (const entry of parsed["projects"]) {
    if (!isRecord(entry)) {
      throw new Error("Every MCP project registry entry must be an object.");
    }

    const id = entry["id"];
    const root = entry["root"];
    const name = entry["name"];
    const enabled = entry["enabled"];

    if (
      typeof id !== "string" ||
      !projectIdPattern.test(id) ||
      typeof root !== "string" ||
      root.length === 0 ||
      (name !== undefined && typeof name !== "string") ||
      (enabled !== undefined && typeof enabled !== "boolean")
    ) {
      throw new Error(
        "Each MCP project needs a valid id, a non-empty root, and an optional name/enabled flag.",
      );
    }
    if (seenIds.has(id)) {
      throw new Error(`Duplicate MCP project id: ${id}`);
    }
    seenIds.add(id);
    if (enabled === false) {
      continue;
    }

    projects.push({
      id,
      name: name ?? id,
      root: await resolveProjectRoot(root),
    });
  }

  if (projects.length === 0) {
    throw new Error("MCP project registry does not contain an enabled project.");
  }
  return projects;
}

export async function getConfiguredProject(projectId: string) {
  if (!projectIdPattern.test(projectId)) {
    throw new Error("projectId must match [a-z0-9][a-z0-9_-]{0,63}.");
  }

  const project = (await loadConfiguredProjects()).find(
    (candidate) => candidate.id === projectId,
  );
  if (!project) {
    throw new Error(`Unknown or disabled MCP project: ${projectId}`);
  }
  return project;
}

export async function listConfiguredProjects() {
  const projects = await loadConfiguredProjects();
  return projects.map(({ id, name }) => ({ id, name }));
}