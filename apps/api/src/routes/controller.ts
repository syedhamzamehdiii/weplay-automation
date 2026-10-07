import type { FastifyPluginAsync } from "fastify";

export const controllerRoutes: FastifyPluginAsync = async (app) => {
  app.get("/controller/status", async () => {
    const settings = await app.ctx.settings.read();
    return { status: settings.controllerStatus };
  });

  app.post("/controller/start", async () => {
    const settings = await app.ctx.settings.setControllerStatus("RUNNING", "CONTROLLER_STARTED");
    return { status: settings.controllerStatus };
  });

  app.post("/controller/pause", async () => {
    const settings = await app.ctx.settings.setControllerStatus("PAUSED", "CONTROLLER_PAUSED");
    return { status: settings.controllerStatus };
  });

  app.post("/controller/resume", async () => {
    const settings = await app.ctx.settings.setControllerStatus("RUNNING", "CONTROLLER_RESUMED");
    return { status: settings.controllerStatus };
  });

  app.post("/controller/stop", async () => {
    const settings = await app.ctx.settings.setControllerStatus("STOPPED", "CONTROLLER_STOPPED");
    const runs = await app.ctx.runs.list();
    for (const run of runs) {
      if (run.status === "ACTIVE" || run.status === "PAUSED") {
        await app.ctx.runs.stop(run.id);
      }
    }
    return { status: settings.controllerStatus };
  });
};
