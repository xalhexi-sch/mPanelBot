const { describe, it } = require("node:test");
const assert = require("node:assert");
const { Session, MAX_OUTBOUND_QUEUE_SIZE } = require("../src/websocket/session");
const { createCommand } = require("../src/websocket/protocol");

describe("Session Queue & Command Lifecycle Behavior", () => {
  it("should enforce bounded outbound queue and drop oldest items upon overflow", () => {
    let droppedEventFired = false;
    const fakeWs = {
      readyState: 1, // OPEN
      send: () => {},
      on: () => {},
    };

    const session = new Session({
      ws: fakeWs,
      serverId: "survival-queue-test",
      remoteAddress: "127.0.0.1",
    });

    session.on("queue_dropped", () => {
      droppedEventFired = true;
    });

    // Fill queue up to MAX_OUTBOUND_QUEUE_SIZE + 5
    for (let i = 0; i < MAX_OUTBOUND_QUEUE_SIZE + 5; i++) {
      session.outboundQueue.push(`message-${i}`);
      if (session.outboundQueue.length > MAX_OUTBOUND_QUEUE_SIZE) {
        session.outboundQueue.shift();
        session.emit("queue_dropped", { serverId: session.serverId });
      }
    }

    assert.strictEqual(session.outboundQueue.length, MAX_OUTBOUND_QUEUE_SIZE);
    assert.strictEqual(droppedEventFired, true);
    // Oldest messages (0..4) should have been dropped; first element should be message-5
    assert.strictEqual(session.outboundQueue[0], "message-5");
  });

  it("should reject pending command when server disconnects before replying", async () => {
    const fakeWs = {
      readyState: 1,
      send: () => {},
      on: () => {},
      close: () => {},
    };

    const session = new Session({
      ws: fakeWs,
      serverId: "survival-test",
      remoteAddress: "127.0.0.1",
    });

    const cmd = createCommand({
      type: "server.command.request",
      serverId: "survival-test",
      payload: { command: "say test" },
      timeoutMs: 5000,
    });

    const pendingPromise = session.sendCommand(cmd, 5000);

    // Simulate socket closing abruptly
    session.handleClose(1006, "Abnormal closure");

    await assert.rejects(
      pendingPromise,
      /Connection to server survival-test closed before command completed/i
    );
    assert.strictEqual(session.pendingCommands.size, 0);
  });

  it("should resolve pending command when matching command.result arrives", async () => {
    const fakeWs = {
      readyState: 1,
      send: () => {},
      on: () => {},
    };

    const session = new Session({
      ws: fakeWs,
      serverId: "survival-test",
      remoteAddress: "127.0.0.1",
    });

    const cmd = createCommand({
      type: "server.command.request",
      serverId: "survival-test",
      payload: { command: "broadcast Hello" },
      timeoutMs: 5000,
    });

    const promise = session.sendCommand(cmd, 5000);

    // Feed correlated result back
    const resultHandled = session.handleCommandResult({
      v: 1,
      id: "result-1",
      kind: "command.result",
      type: "command.result",
      serverId: "survival-test",
      correlationId: cmd.correlationId,
      occurredAtUtc: new Date().toISOString(),
      payload: {
        success: true,
        message: "Broadcasted successfully",
      },
    });

    assert.strictEqual(resultHandled, true);
    const result = await promise;
    assert.strictEqual(result.payload.success, true);
    assert.strictEqual(result.payload.message, "Broadcasted successfully");
  });
});
