import { logger } from "../lib/logger";

export type McpLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  event: string;
  projectId?: string;
  details?: Record<string, unknown>;
};

const MAX_ENTRIES = 500;
const entries: McpLogEntry[] = [];

export function recordMcpLog(
  level: McpLogEntry["level"],
  event: string,
  details?: Record<string, unknown>,
) {
  const entry: McpLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...(details ? { details } : {}),
  };

  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
  }

  const logDetails = { mcpEvent: event, ...(details ?? {}) };
  if (level === "error") {
    logger.error(logDetails);
  } else if (level === "warn") {
    logger.warn(logDetails);
  } else {
    logger.info(logDetails);
  }
}

export function getMcpLogs(
  limit = 100,
  since?: string,
  projectId?: string,
): McpLogEntry[] {
  const sinceTimestamp = since ? Date.parse(since) : Number.NaN;
  return entries
    .filter((entry) => {
      if (projectId && entry.projectId !== projectId) {
        return false;
      }
      if (Number.isNaN(sinceTimestamp)) {
        return true;
      }
      return Date.parse(entry.timestamp) > sinceTimestamp;
    })
    .slice(-limit);
}