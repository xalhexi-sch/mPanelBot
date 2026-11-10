const { describe, it } = require("node:test");
const assert = require("node:assert");
const { GameWebSocketServer } = require("../src/websocket/server");

describe("WebSocket Handshake Authentication", () => {
  const secretKey = "super-secret-mPanel-key-1234567890";
  const wsServer = new GameWebSocketServer({ apiKey: secretKey });

  it("should accept valid Bearer token matching the apiKey", () => {
    const validHeader = `Bearer ${secretKey}`;
    assert.strictEqual(wsServer.isAuthorizedHeader(validHeader), true);
  });

  it("should accept valid raw apiKey (e.g. from x-api-key header)", () => {
    assert.strictEqual(wsServer.isAuthorizedHeader(secretKey), true);
  });

  it("should reject token with incorrect value", () => {
    const wrongHeader = "Bearer wrong-secret-key-1234567890";
    assert.strictEqual(wsServer.isAuthorizedHeader(wrongHeader), false);
  });

  it("should reject token with different length (timingSafeEqual safety)", () => {
    const shortHeader = "Bearer short";
    assert.strictEqual(wsServer.isAuthorizedHeader(shortHeader), false);

    const longHeader = "Bearer super-secret-mPanel-key-1234567890-extra-characters";
    assert.strictEqual(wsServer.isAuthorizedHeader(longHeader), false);
  });

  it("should reject null, undefined, or empty auth headers", () => {
    assert.strictEqual(wsServer.isAuthorizedHeader(null), false);
    assert.strictEqual(wsServer.isAuthorizedHeader(undefined), false);
    assert.strictEqual(wsServer.isAuthorizedHeader(""), false);
    assert.strictEqual(wsServer.isAuthorizedHeader("Bearer "), false);
  });
});
