import { Router, type IRouter } from "express";
import healthRouter from "./health";
import mcpRouter from "./mcp";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/mcp", mcpRouter);

export default router;
