import type { FastifyPluginAsync } from "fastify";

export const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get("/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": app.ctx.env.CORS_ORIGIN
    });
    reply.raw.write("event: ready\ndata: {}\n\n");

    const send = (payload: { type: string; data: unknown }) => {
      reply.raw.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload.data)}\n\n`);
    };

    const unsubscribe = app.ctx.bus.subscribe(send);
    const ping = setInterval(() => {
      reply.raw.write("event: ping\ndata: {}\n\n");
    }, 15000);

    request.raw.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  });
};
