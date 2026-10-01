import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import {
  getConfiguredProject,
  listConfiguredProjects,
} from "./project-registry";
import {
  getMcpLogs,
  recordMcpLog,
} from "./log-buffer";
import {
  listWorkspace,
  readWorkspaceFile,
  resolveWorkspacePath,
  writeWorkspaceFile,
} from "./workspace";

const MAX_COMMAND_OUTPUT_BYTES = 200_000;
const MAX_COMMAND_TIMEOUT_MS = 120_000;

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text" as const,
        text:
          typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2),
      },
    ],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(tool: string, error: unknown, projectId?: string) {
  const message = error instanceof Error ? error.message : "Unknown tool error";
  recordMcpLog("error", "tool.failed", {
    tool,
    ...(projectId ? { projectId } : {}),
    message,
  });
  return textResult({ error: message }, true);
}

function safeCommandEnvironment() {
  const explicitlyBlocked = new Set([
    "DATABASE_URL",
    "PGPASSWORD",
    "PGUSER",
    "PGHOST",
    "PGPORT",
    "REPLIT_IDENTITY",
    "WEB_REPL_RENEWAL",
  ]);

  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return (
        !explicitlyBlocked.has(key) &&
        !/(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|ACCESS_KEY|CREDENTIAL|COOKIE)/i.test(
          key,
        )
      );
    }),
  );
}

function classifyCommand(command: string) {
  const alwaysBlocked = [
    /\b(?:sudo|su|shutdown|reboot|mkfs|mount|umount|killall|pkill)\b/i,
    /rm\s+-rf\s+\/(?:\s|$)/i,
    /:\(\)\s*\{\s*:\|:\s*&\s*\};:/,
    />\s*\/dev\//i,
    /\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash)\b/i,
  ];
  const requiresExplicitApproval = [
    /\b(?:rm|rmdir|unlink|shred)\b/i,
    /\bgit\s+(?:clean|reset\s+--hard|push)\b/i,
    /\b(?:pnpm|npm|yarn)\s+publish\b/i,
    /\b(?:replit|vercel|netlify|railway|flyctl)\s+(?:deploy|publish)\b/i,
    /\b(?:terraform|pulumi)\s+apply\b/i,
  ];

  if (alwaysBlocked.some((pattern) => pattern.test(command))) {
    return "blocked";
  }
  if (requiresExplicitApproval.some((pattern) => pattern.test(command))) {
    return "approval";
  }
  return "allowed";
}

async function runWorkspaceCommand(
  projectId: string,
  command: string,
  requestedCwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
  allowDangerous: boolean,
) {
  const classification = classifyCommand(command);
  if (classification === "blocked") {
    throw new Error("This shell command is blocked by the MCP safety policy.");
  }
  if (classification === "approval" && !allowDangerous) {
    throw new Error(
      "This command may delete, publish, push, or deploy. Repeat it with allowDangerous=true for explicit approval.",
    );
  }

  const project = await getConfiguredProject(projectId);
  const cwd = await resolveWorkspacePath(project, requestedCwd);
  const cwdStats = await stat(cwd.absolutePath);
  if (!cwdStats.isDirectory()) {
    throw new Error("The command working directory must be a directory.");
  }

  const boundedTimeout = Math.min(timeoutMs, MAX_COMMAND_TIMEOUT_MS);
  const boundedOutput = Math.min(maxOutputBytes, MAX_COMMAND_OUTPUT_BYTES);
  const child = spawn("bash", ["-lc", command], {
    cwd: cwd.absolutePath,
    env: safeCommandEnvironment(),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  let outputBytes = 0;
  let outputTruncated = false;
  let timedOut = false;

  const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer) => {
    if (outputBytes >= boundedOutput) {
      outputTruncated = true;
      return;
    }

    const remaining = boundedOutput - outputBytes;
    const prefix = `[${stream}]\n`;
    const prefixBytes = Buffer.byteLength(prefix, "utf8");
    const text = chunk.subarray(
      0,
      Math.max(0, remaining - prefixBytes),
    ).toString("utf8");
    output += prefix + text;
    outputBytes += Buffer.byteLength(prefix + text, "utf8");
    if (chunk.byteLength > Math.max(0, remaining - prefixBytes)) {
      outputTruncated = true;
    }
  };

  child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));

  const result = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          child.kill("SIGTERM");
        }
      }
    }, boundedTimeout);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      resolve({ exitCode, signal });
    });
  });

  return {
    projectId,
    command,
    cwd: cwd.relativePath,
    ...result,
    timedOut,
    output,
    outputTruncated,
    explicitApprovalUsed: allowDangerous && classification === "approval",
  };
}

export function createMcpServer() {
  const server = new McpServer(
    {
      name: "replit-multi-project-gateway",
      version: "2.0.0",
    },
    { capabilities: { logging: {} } },
  );

  server.registerTool(
    "workspace_list_projects",
    {
      title: "List configured projects",
      description:
        "List project IDs available through this authenticated MCP gateway. This does not read project files and never selects a project automatically.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const projects = await listConfiguredProjects();
        recordMcpLog("info", "projects.listed", {
          count: projects.length,
        });
        return textResult({ projects });
      } catch (error) {
        return errorResult("workspace_list_projects", error);
      }
    },
  );

  server.registerTool(
    "workspace_list_files",
    {
      title: "List project files",
      description:
        "List files and directories inside the explicitly selected project workspace. Credential files and symlinks are excluded.",
      inputSchema: {
        projectId: z.string().min(1),
        path: z.string().default(".").describe("Relative path inside the selected project"),
        recursive: z.boolean().default(false),
        maxEntries: z.number().int().min(1).max(5000).default(200),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, path, recursive, maxEntries }) => {
      try {
        const project = await getConfiguredProject(projectId);
        recordMcpLog("info", "tool.started", {
          tool: "workspace_list_files",
          projectId,
          path,
        });
        const entries = await listWorkspace(
          project,
          path,
          recursive,
          maxEntries,
        );
        recordMcpLog("info", "tool.completed", {
          tool: "workspace_list_files",
          projectId,
          count: entries.length,
        });
        return textResult({ projectId, entries });
      } catch (error) {
        return errorResult("workspace_list_files", error, projectId);
      }
    },
  );

  server.registerTool(
    "workspace_read_file",
    {
      title: "Read a project file",
      description:
        "Read UTF-8 text from a file inside the explicitly selected project workspace.",
      inputSchema: {
        projectId: z.string().min(1),
        path: z.string().min(1),
        maxBytes: z.number().int().min(1).max(1_000_000).default(200_000),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, path, maxBytes }) => {
      try {
        const project = await getConfiguredProject(projectId);
        recordMcpLog("info", "tool.started", {
          tool: "workspace_read_file",
          projectId,
          path,
        });
        const result = await readWorkspaceFile(project, path, maxBytes);
        recordMcpLog("info", "tool.completed", {
          tool: "workspace_read_file",
          projectId,
          path: result.path,
          bytes: result.bytes,
        });
        return textResult(result);
      } catch (error) {
        return errorResult("workspace_read_file", error, projectId);
      }
    },
  );

  server.registerTool(
    "workspace_write_file",
    {
      title: "Write a project file",
      description:
        "Create or overwrite a UTF-8 text file inside the explicitly selected project workspace. Writes are limited to 1 MB, credential files are blocked, and the project registry is protected.",
      inputSchema: {
        projectId: z.string().min(1),
        path: z.string().min(1),
        content: z.string().max(1_000_000),
        overwrite: z.boolean().default(true),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({ projectId, path, content, overwrite }) => {
      try {
        const project = await getConfiguredProject(projectId);
        recordMcpLog("info", "tool.started", {
          tool: "workspace_write_file",
          projectId,
          path,
        });
        const result = await writeWorkspaceFile(
          project,
          path,
          content,
          overwrite,
        );
        recordMcpLog("info", "tool.completed", {
          tool: "workspace_write_file",
          projectId,
          path: result.path,
          bytes: result.bytes,
        });
        return textResult({ written: true, ...result });
      } catch (error) {
        return errorResult("workspace_write_file", error, projectId);
      }
    },
  );

  server.registerTool(
    "workspace_run_shell",
    {
      title: "Run a project shell command",
      description:
        "Run a bash command from a directory inside the explicitly selected project. Secrets are removed from the child environment; execution has a timeout and bounded output. Deletion, publish, push, and deploy patterns require allowDangerous=true.",
      inputSchema: {
        projectId: z.string().min(1),
        command: z.string().min(1).max(20_000),
        cwd: z.string().default("."),
        timeoutMs: z.number().int().min(100).max(MAX_COMMAND_TIMEOUT_MS).default(30_000),
        maxOutputBytes: z.number().int().min(1).max(MAX_COMMAND_OUTPUT_BYTES).default(100_000),
        allowDangerous: z.boolean().default(false),
      },
      annotations: { destructiveHint: true, openWorldHint: false },
    },
    async ({
      projectId,
      command,
      cwd,
      timeoutMs,
      maxOutputBytes,
      allowDangerous,
    }) => {
      try {
        recordMcpLog("info", "tool.started", {
          tool: "workspace_run_shell",
          projectId,
          cwd,
          allowDangerous,
        });
        const result = await runWorkspaceCommand(
          projectId,
          command,
          cwd,
          timeoutMs,
          maxOutputBytes,
          allowDangerous,
        );
        recordMcpLog("info", "tool.completed", {
          tool: "workspace_run_shell",
          projectId,
          cwd: result.cwd,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          explicitApprovalUsed: result.explicitApprovalUsed,
        });
        return textResult(result, result.timedOut || result.exitCode !== 0);
      } catch (error) {
        return errorResult("workspace_run_shell", error, projectId);
      }
    },
  );

  server.registerTool(
    "workspace_get_logs",
    {
      title: "Get project MCP activity logs",
      description:
        "Return recent bounded MCP activity logs for the explicitly selected project, optionally filtered by an ISO timestamp.",
      inputSchema: {
        projectId: z.string().min(1),
        limit: z.number().int().min(1).max(500).default(100),
        since: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, limit, since }) => {
      try {
        await getConfiguredProject(projectId);
        const logs = getMcpLogs(limit, since, projectId);
        return textResult({ projectId, logs, count: logs.length });
      } catch (error) {
        return errorResult("workspace_get_logs", error, projectId);
      }
    },
  );

  return server;
}