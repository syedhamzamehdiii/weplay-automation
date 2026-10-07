import { firstDeviceSerial, sleep } from "./adb.js";
import { CreateAccountFailed, inspectCreateAccount } from "./createAccount.js";
import { JoinFailed, joinRoom } from "./joinRoom.js";
import { SetupFailed, provisionSetup } from "./setupAccount.js";

const API_URL = process.env.WEPLAY_API_URL ?? "http://127.0.0.1:3001";
const WORKER_VERSION = "usb-adb-6";

interface ClaimedJob {
  id: string;
  executionId: string;
  configuration: { kind?: string; roomId?: string; loginProvider?: string; resume?: boolean };
}

async function api(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "POST" || method === "PATCH" || method === "PUT") {
    headers.set("Content-Type", "application/json");
  }
  if (init.token) {
    headers.set("Authorization", `Bearer ${init.token}`);
  }
  const body = init.body === undefined && method !== "GET" ? "{}" : init.body;
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, body });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `${method} ${path} failed (${response.status})`);
  }
  return response;
}

async function register(serial: string): Promise<string> {
  const response = await api("/api/workers/register", {
    method: "POST",
    body: JSON.stringify({
      name: `usb-${serial.slice(0, 8)}`,
      deviceIdentifier: serial,
      workerVersion: WORKER_VERSION
    })
  });
  const body = (await response.json()) as { token: string };
  return body.token;
}

async function loop(): Promise<void> {
  let token = "";
  let serial = process.env.WEPLAY_ADB_SERIAL?.trim() || "";
  console.log(`[usb-worker] API ${API_URL}`);

  while (true) {
    try {
      if (!serial) {
        serial = await firstDeviceSerial();
      }
      if (!token) {
        token = await register(serial);
        console.log(`[usb-worker] registered for ${serial}`);
      }
      await api("/api/workers/heartbeat", { method: "POST", token, body: JSON.stringify({ status: "IDLE" }) });
      const claimResponse = await api("/api/workers/jobs/claim", { method: "POST", token });
      const { job } = (await claimResponse.json()) as { job: ClaimedJob | null };
      if (!job) {
        await sleep(1500);
        continue;
      }

      const kind = job.configuration.kind ?? "join_room";
      await api(`/api/workers/jobs/${job.id}/start`, {
        method: "POST",
        token,
        body: JSON.stringify({ executionId: job.executionId })
      });

      if (kind === "create_account") {
        const provider = job.configuration.loginProvider ?? "GOOGLE";
        await api(`/api/workers/jobs/${job.id}/progress`, {
          method: "POST",
          token,
          body: JSON.stringify({
            executionId: job.executionId,
            event: "ACCOUNT_CREATION_PROGRESS",
            message: `Inspecting WePlay login for ${provider}`
          })
        });
        try {
          await inspectCreateAccount(serial, provider);
        } catch (error) {
          const failed =
            error instanceof CreateAccountFailed
              ? error
              : new CreateAccountFailed("UNKNOWN_STATE", (error as Error).message);
          await api(`/api/workers/jobs/${job.id}/fail`, {
            method: "POST",
            token,
            body: JSON.stringify({
              executionId: job.executionId,
              errorCode: failed.errorCode,
              errorMessage: failed.message
            })
          });
          console.error(`[usb-worker] create_account failed: ${failed.message}`);
        }
        continue;
      }

      if (kind === "setup" || kind === "reauth") {
        const provider = job.configuration.loginProvider ?? "GOOGLE";
        const resume = job.configuration.resume === true || kind === "reauth";
        try {
          const result = await provisionSetup(
            serial,
            provider,
            resume,
            async (message) => {
              await api(`/api/workers/jobs/${job.id}/progress`, {
                method: "POST",
                token,
                body: JSON.stringify({
                  executionId: job.executionId,
                  event: "ACCOUNT_SETUP_PROGRESS",
                  message
                })
              });
            },
            async () => {
              await api("/api/workers/heartbeat", {
                method: "POST",
                token,
                body: JSON.stringify({ status: "BUSY" })
              });
            }
          );
          await api(`/api/workers/jobs/${job.id}/complete`, {
            method: "POST",
            token,
            body: JSON.stringify({ executionId: job.executionId, verified: true })
          });
          console.log(`[usb-worker] setup verified for ${provider}: ${result.screen}`);
        } catch (error) {
          const failed =
            error instanceof SetupFailed ? error : new SetupFailed("UNKNOWN_STATE", (error as Error).message);
          await api(`/api/workers/jobs/${job.id}/fail`, {
            method: "POST",
            token,
            body: JSON.stringify({
              executionId: job.executionId,
              errorCode: failed.errorCode,
              errorMessage: failed.message
            })
          });
          console.error(`[usb-worker] setup failed: ${failed.message}`);
        }
        continue;
      }

      if (kind === "support") {
        await api(`/api/workers/jobs/${job.id}/fail`, {
          method: "POST",
          token,
          body: JSON.stringify({
            executionId: job.executionId,
            errorCode: "AUTOMATION_NOT_INSPECTED",
            errorMessage: "Support UI is not mapped yet; USB worker only joins the room"
          })
        });
        continue;
      }

      const roomId = job.configuration.roomId ?? "";
      await api(`/api/workers/jobs/${job.id}/progress`, {
        method: "POST",
        token,
        body: JSON.stringify({
          executionId: job.executionId,
          event: "JOB_PROGRESS",
          message: `Joining ${roomId}`
        })
      });

      try {
        const focus = await joinRoom(serial, roomId);
        await api(`/api/workers/jobs/${job.id}/progress`, {
          method: "POST",
          token,
          body: JSON.stringify({
            executionId: job.executionId,
            event: "ROOM_OPENED",
            message: focus
          })
        });
        await api(`/api/workers/jobs/${job.id}/complete`, {
          method: "POST",
          token,
          body: JSON.stringify({ executionId: job.executionId, verified: true })
        });
        console.log(`[usb-worker] joined ${roomId}`);
      } catch (error) {
        const failed = error instanceof JoinFailed ? error : new JoinFailed("UNKNOWN_STATE", (error as Error).message);
        await api(`/api/workers/jobs/${job.id}/fail`, {
          method: "POST",
          token,
          body: JSON.stringify({
            executionId: job.executionId,
            errorCode: failed.errorCode,
            errorMessage: failed.message
          })
        });
        console.error(`[usb-worker] join failed: ${failed.message}`);
      }
    } catch (error) {
      token = "";
      console.error(`[usb-worker] ${(error as Error).message}`);
      await sleep(3000);
    }
    await sleep(1000);
  }
}

void loop();
