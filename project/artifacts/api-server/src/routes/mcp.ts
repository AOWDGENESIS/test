import { Router, type IRouter, type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server";
import { recordMcpLog } from "../mcp/log-buffer";

const router: IRouter = Router();

function hasValidBearerToken(authorizationHeader: string | undefined) {
  const expectedToken = process.env["MCP_AUTH_TOKEN"];
  if (!expectedToken || !authorizationHeader) {
    return false;
  }

  const [scheme, suppliedToken] = authorizationHeader.split(" ", 2);
  if (scheme?.toLowerCase() !== "bearer" || !suppliedToken) {
    return false;
  }

  const expected = Buffer.from(expectedToken, "utf8");
  const supplied = Buffer.from(suppliedToken, "utf8");
  return (
    expected.length === supplied.length &&
    timingSafeEqual(expected, supplied)
  );
}

router.use((req, res, next) => {
  if (!process.env["MCP_AUTH_TOKEN"]) {
    res.status(503).json({
      error: "MCP_AUTH_TOKEN is not configured on the server.",
    });
    return;
  }

  if (!hasValidBearerToken(req.header("authorization"))) {
    res
      .status(401)
      .setHeader("WWW-Authenticate", 'Bearer realm="replit-mcp"')
      .json({ error: "A valid Bearer token is required." });
    return;
  }

  next();
});

router.post("/", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    maxRequestBodySize: 4 * 1024 * 1024,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    recordMcpLog("error", "http.request_failed", {
      message: error instanceof Error ? error.message : "Unknown MCP request error",
    });
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal MCP server error",
        },
        id: null,
      });
    }
  } finally {
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  }
});

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

router.get("/", methodNotAllowed);
router.delete("/", methodNotAllowed);

export default router;