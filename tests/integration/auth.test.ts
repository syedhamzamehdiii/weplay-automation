import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, login } from "../helpers/app.js";

describe("authentication and authorization", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) {
      await fn();
    }
    cleanup = [];
  });

  it("rejects invalid credentials", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "wrong" }
    });
    expect(response.statusCode).toBe(401);
  });

  it("issues a token and requires it for accounts", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const unauth = await app.inject({ method: "GET", url: "/api/accounts" });
    expect(unauth.statusCode).toBe(401);

    const { headers } = await login(app);
    const authd = await app.inject({ method: "GET", url: "/api/accounts", headers });
    expect(authd.statusCode).toBe(200);
    expect(authd.json()).toEqual([]);
  });

  it("rejects worker tokens on operator routes", async () => {
    const { app, db } = await createTestApp();
    cleanup.push(async () => {
      await app.close();
      await db.close();
    });
    const registered = await app.inject({
      method: "POST",
      url: "/api/workers/register",
      payload: { name: "w1", deviceIdentifier: "dev-1", workerVersion: "1" }
    });
    const token = (registered.json() as { token: string }).token;
    const response = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { authorization: `Bearer ${token}` }
    });
    expect(response.statusCode).toBe(401);
  });
});
