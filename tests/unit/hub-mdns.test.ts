import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  HUB_SERVICE_NAME,
  createMdnsAnnouncer,
  decodeMdnsMessage,
  discoverHubs,
  encodeMdnsQuery,
  buildMdnsResponse,
  type MdnsResponseInput,
  type MdnsSocketLike
} from "../../src/services/lanHub/mdns";

interface SentPacket {
  message: Buffer;
  port?: number;
  address?: string;
}

interface FakeSocket extends MdnsSocketLike {
  sent: SentPacket[];
  closed: boolean;
  emit(event: string, ...args: unknown[]): void;
}

/** Socket UDP falso: registra envíos y permite inyectar respuestas. */
function fakeSocket(): FakeSocket {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket: FakeSocket = {
    sent: [],
    closed: false,
    on(event, listener) {
      listeners.set(event, listener);
      return socket;
    },
    send(message, port, address, callback) {
      socket.sent.push({ message, port, address });
      callback?.(null);
    },
    close() {
      socket.closed = true;
    },
    emit(event, ...args) {
      listeners.get(event)?.(...args);
    }
  };
  return socket;
}

const FINGERPRINT = "cd".repeat(32);

function announceInput(overrides: Partial<MdnsResponseInput> = {}): MdnsResponseInput {
  return {
    instanceName: "pos-1",
    port: 49000,
    addresses: ["192.168.1.10", "10.0.0.5"],
    txt: { v: "1", fp: FINGERPRINT, path: "/lan/v1" },
    ttlSeconds: 120,
    ...overrides
  };
}

test("encodeMdnsQuery emite una única pregunta PTR del servicio del hub", () => {
  const query = encodeMdnsQuery();
  const message = decodeMdnsMessage(query);
  assert.equal(message.id, 0);
  assert.equal(message.questions.length, 1);
  assert.equal(message.questions[0].name, HUB_SERVICE_NAME);
  assert.equal(message.questions[0].type, 12);
  assert.equal(message.questions[0].typeName, "PTR");
  assert.equal(message.answers.length, 0);
});

test("buildMdnsResponse hace round-trip con PTR, SRV, TXT, A y nombres comprimidos", () => {
  const buffer = buildMdnsResponse(announceInput());
  const message = decodeMdnsMessage(buffer);

  assert.equal(message.flags & 0x8000, 0x8000, "debe marcarse como respuesta");
  const ptr = message.answers.find((record) => record.typeName === "PTR");
  assert.ok(ptr);
  assert.equal(ptr.name, "_palmyra-hub._tcp.local");
  assert.equal(ptr.target, "pos-1._palmyra-hub._tcp.local");
  assert.equal(ptr.ttl, 120);

  const srv = message.answers.find((record) => record.typeName === "SRV");
  assert.ok(srv);
  assert.equal(srv.name, "pos-1._palmyra-hub._tcp.local");
  assert.equal(srv.port, 49000);
  assert.equal(srv.target, "palmyra-hub.local");
  assert.equal(srv.priority, 0);
  assert.equal(srv.weight, 0);

  const txt = message.answers.find((record) => record.typeName === "TXT");
  assert.ok(txt);
  assert.deepEqual(
    [...(txt.txt ?? [])].sort(),
    [`fp=${FINGERPRINT}`, "path=/lan/v1", "v=1"].sort()
  );

  const addrs = message.answers
    .filter((record) => record.typeName === "A")
    .map((record) => record.address);
  assert.deepEqual(addrs, ["192.168.1.10", "10.0.0.5"]);

  // La compresión de sufijos debe acortar el mensaje frente a nombres completos.
  const plain = buildMdnsResponse(announceInput({ compress: false }));
  assert.ok(buffer.length < plain.length, `comprimido ${buffer.length} vs plano ${plain.length}`);
  // El sufijo del servicio ya escrito al inicio se referencia con 0xC00C.
  assert.ok(buffer.includes(Buffer.from([0xc0, 0x0c])), "usa punteros de compresión");
});

test("decodeMdnsMessage es tolerante a basura, truncados y punteros en bucle", () => {
  const junk = [
    Buffer.alloc(0),
    Buffer.from("basura"),
    Buffer.from([0, 0, 0, 0, 0, 1]),
    crypto.randomBytes(64)
  ];
  for (const buffer of junk) {
    const message = decodeMdnsMessage(buffer);
    assert.ok(Array.isArray(message.questions));
    assert.ok(Array.isArray(message.answers));
    assert.ok(Array.isArray(message.additionals));
  }

  const full = buildMdnsResponse(announceInput());
  const truncated = decodeMdnsMessage(full.subarray(0, 30));
  assert.ok(Array.isArray(truncated.answers));

  // Pregunta que apunta a sí misma: el decodificador corta sin colgarse.
  const loop = Buffer.alloc(18);
  loop.writeUInt16BE(1, 4); // QDCOUNT
  loop[12] = 0xc0;
  loop[13] = 0x0c;
  assert.doesNotThrow(() => decodeMdnsMessage(loop));
  assert.equal(decodeMdnsMessage(loop).questions.length, 0);
});

test("el anunciador envía el anuncio y stop cierra el socket (socket falso)", () => {
  const socket = fakeSocket();
  const announcer = createMdnsAnnouncer({
    port: 49000,
    addresses: ["192.168.1.10"],
    txt: { v: "1", fp: FINGERPRINT, path: "/lan/v1" },
    instanceName: "pos-1",
    socket,
    announceIntervalMs: 60_000
  });

  announcer.start();
  assert.equal(announcer.started, true);
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].address, "224.0.0.251");
  assert.equal(socket.sent[0].port, 5353);

  const announced = decodeMdnsMessage(socket.sent[0].message);
  assert.equal(announced.answers.filter((record) => record.typeName === "PTR").length, 1);
  assert.equal(announced.answers.filter((record) => record.typeName === "SRV").length, 1);
  assert.equal(announced.answers.filter((record) => record.typeName === "TXT").length, 1);
  assert.equal(announced.answers.filter((record) => record.typeName === "A").length, 1);

  // Arrancar dos veces no duplica el anuncio ni el temporizador.
  announcer.start();
  assert.equal(socket.sent.length, 1);

  announcer.stop();
  assert.equal(announcer.started, false);
  assert.equal(socket.closed, true);
});

test("discoverHubs arma el hub desde las respuestas mDNS", async () => {
  const response = buildMdnsResponse(announceInput({ addresses: ["192.168.1.10"] }));
  let socket: FakeSocket | null = null;
  let queryBuffer: Buffer | null = null;
  const pending = discoverHubs({
    timeoutMs: 100,
    query: (buffer) => {
      queryBuffer = buffer;
    },
    sockets: {
      create: () => {
        socket = fakeSocket();
        return socket;
      }
    }
  });

  assert.ok(socket);
  assert.ok(queryBuffer);
  assert.equal(decodeMdnsMessage(queryBuffer).questions[0].typeName, "PTR");
  assert.equal(socket.sent.length, 1);
  assert.equal(socket.sent[0].address, "224.0.0.251");
  assert.equal(socket.sent[0].port, 5353);

  // Basura primero: no debe romper el descubrimiento.
  socket.emit("message", crypto.randomBytes(32), { address: "192.168.1.10" });
  socket.emit("message", response, { address: "192.168.1.10" });

  const hubs = await pending;
  assert.equal(hubs.length, 1);
  assert.deepEqual(hubs[0], {
    host: "192.168.1.10",
    port: 49000,
    url: "https://192.168.1.10:49000",
    fingerprint: FINGERPRINT,
    name: "pos-1"
  });
  assert.equal(socket.closed, true);
});

test("discoverHubs tolera fallos de socket y anuncios sin TLS", async () => {
  const withoutSocket = await discoverHubs({
    timeoutMs: 50,
    sockets: {
      create: () => {
        throw new Error("sin multicast");
      }
    }
  });
  assert.deepEqual(withoutSocket, []);

  const response = buildMdnsResponse(announceInput({ txt: { v: "1", path: "/lan/v1" } }));
  let socket: FakeSocket | null = null;
  const pending = discoverHubs({
    timeoutMs: 60,
    sockets: {
      create: () => {
        socket = fakeSocket();
        return socket;
      }
    }
  });
  socket!.emit("message", response, { address: "192.168.1.10" });
  const hubs = await pending;
  assert.equal(hubs.length, 1);
  assert.equal(hubs[0].fingerprint, "");
  assert.equal(hubs[0].url, "http://192.168.1.10:49000");
});
