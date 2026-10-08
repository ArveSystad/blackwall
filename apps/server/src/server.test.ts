import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { parseServerEvent, type ServerEvent } from "@blackwall/shared";
import { tokenCookieName } from "./auth.js";
import { startServer } from "./server.js";
import { createShutdown } from "./shutdown.js";

const token = "test-token";
let shutdown = createShutdown();

afterEach(async () => {
  await shutdown.run();
  shutdown = createShutdown();
});

function nextEvent(ws: WebSocket): Promise<ServerEvent | null> {
  return new Promise((resolve) =>
    ws.once("message", (data) => resolve(parseServerEvent(String(data)))),
  );
}

describe("server", () => {
  it("answers WebSocket ping with pong", async () => {
    const { port } = await startServer({ port: 0, dev: true, token, shutdown });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { cookie: `${tokenCookieName(port)}=${token}` },
    });
    await new Promise((resolve, reject) => ws.once("open", resolve).once("error", reject));

    ws.send(JSON.stringify({ type: "ping", payload: { id: "abc" } }));
    const event = await nextEvent(ws);
    expect(event?.type).toBe("pong");
    expect(event?.payload).toMatchObject({ id: "abc" });

    ws.send("garbage");
    expect((await nextEvent(ws))?.type).toBe("error");
    ws.close();
  });

  it("refuses a WebSocket upgrade without the token", async () => {
    const { port } = await startServer({ port: 0, dev: true, token, shutdown });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on("error", () => {});
    const status = await new Promise<number | undefined>((resolve) => {
      ws.once("unexpected-response", (req, res) => {
        resolve(res.statusCode);
        req.destroy();
      });
      ws.once("open", () => resolve(undefined));
    });
    expect(status).toBe(401);
  });

  it("builds a launch URL carrying the token", async () => {
    const prod = await startServer({ port: 0, dev: false, token, shutdown });
    expect(prod.launchUrl).toBe(`http://127.0.0.1:${prod.port}/?t=${token}`);
  });
});
