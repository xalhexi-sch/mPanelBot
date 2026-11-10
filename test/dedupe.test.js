const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");
const { DatabaseManager } = require("../src/database");
const { DedupeRepository } = require("../src/database/repositories/dedupeRepository");
const { MessageRouter } = require("../src/websocket/router");

describe("Event Deduplication & Idempotency", () => {
  let db;
  let dedupeRepo;

  beforeEach(() => {
    db = new DatabaseManager(":memory:");
    dedupeRepo = new DedupeRepository(db);
  });

  it("should detect when an event is new vs duplicate by (serverId, id)", () => {
    const serverId = "survival-1";
    const eventId = "evt-12345";

    assert.strictEqual(dedupeRepo.isEventProcessed(serverId, eventId), false);

    const marked = dedupeRepo.markEventProcessed(serverId, eventId, "player.kill");
    assert.strictEqual(marked, true);

    assert.strictEqual(dedupeRepo.isEventProcessed(serverId, eventId), true);
  });

  it("should isolate deduplication across different serverIds", () => {
    const eventId = "evt-same-id";

    dedupeRepo.markEventProcessed("server-A", eventId, "player.connected");
    assert.strictEqual(dedupeRepo.isEventProcessed("server-A", eventId), true);
    assert.strictEqual(dedupeRepo.isEventProcessed("server-B", eventId), false);
  });

  it("should reply with status: 'duplicate' ACK when duplicate event arrives in MessageRouter", async () => {
    const sentMessages = [];
    const fakeSession = {
      serverId: "survival-1",
      send: (msg) => sentMessages.push(typeof msg === "string" ? JSON.parse(msg) : msg),
    };

    const router = new MessageRouter({
      dedupeRepo,
      snapshotRepo: { saveSnapshot: () => {} },
      statsRepo: {},
      linkService: {},
      discordLogger: null,
      raidNotifier: null,
      chatRelay: null,
      discordClient: null,
    });

    const envelope = {
      v: 1,
      id: "dup-event-99",
      kind: "event",
      type: "server.snapshot",
      serverId: "survival-1",
      occurredAtUtc: new Date().toISOString(),
      payload: { onlineCount: 5 },
    };

    // First arrival -> persisted
    await router.handleEnvelope(fakeSession, envelope);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].kind, "ack");
    assert.strictEqual(sentMessages[0].payload.status, "persisted");

    // Second arrival -> duplicate ACK immediately without reprocessing
    await router.handleEnvelope(fakeSession, envelope);
    assert.strictEqual(sentMessages.length, 2);
    assert.strictEqual(sentMessages[1].kind, "ack");
    assert.strictEqual(sentMessages[1].payload.status, "duplicate");
  });
});
