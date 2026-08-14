import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpLogger as logger } from "@/lib/logger";
import * as schemas from "./schemas";
import * as tools from "./tools";

export function createFakeFalMcpServer(): McpServer {
  const server = new McpServer({ name: "fal-ai", version: "0.1.0" });

  server.registerTool("recommend_model",
    { title: "Recommend a model", description: "Test-mode fal mirror.", inputSchema: schemas.RecommendModelSchema },
    async (a) => tools.recommend_model(a));
  server.registerTool("get_model_schema",
    { title: "Get model schema", description: "Test-mode fal mirror.", inputSchema: schemas.GetSchemaSchema },
    async (a) => tools.get_model_schema(a));
  server.registerTool("get_pricing",
    { title: "Get pricing", description: "Test-mode fal mirror.", inputSchema: schemas.GetPricingSchema },
    async (a) => tools.get_pricing(a));
  server.registerTool("run_model",
    { title: "Run a model", description: "Test-mode fal mirror (sync placeholder).", inputSchema: schemas.RunModelSchema },
    async (a) => tools.run_model(a));
  server.registerTool("submit_job",
    { title: "Submit an async job", description: "Test-mode fal mirror.", inputSchema: schemas.SubmitJobSchema },
    async (a) => tools.submit_job(a));
  server.registerTool("check_job",
    { title: "Check a job", description: "Test-mode fal mirror.", inputSchema: schemas.CheckJobSchema },
    async (a) => tools.check_job(a));
  server.registerTool("get_job_result",
    { title: "Get a job result", description: "Test-mode fal mirror.", inputSchema: schemas.GetJobResultSchema },
    async (a) => tools.get_job_result(a));
  server.registerTool("search_docs",
    { title: "Search docs", description: "Test-mode fal mirror (stub).", inputSchema: schemas.SearchDocsSchema },
    async (a) => tools.search_docs(a));

  logger.info({ tag: "fake-fal" }, "fake-fal MCP server created (masquerading as fal-ai)");
  return server;
}
