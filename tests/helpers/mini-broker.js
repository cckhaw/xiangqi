'use strict';
/*
 * Minimal MQTT 3.1.1 broker for tests: QoS 0, retained messages, wildcard
 * "#" subscriptions, last-will, keepalive pings. Written independently of
 * net.js's codec so the two check each other.
 *
 * BrokerCore is transport-agnostic; startWebSocketBroker() puts it behind a
 * real RFC 6455 WebSocket server on localhost, and attachToRoute() plugs it
 * into Playwright's page.routeWebSocket().
 */
const http = require('node:http');
const crypto = require('node:crypto');

const utf8 = (b) => Buffer.from(b).toString('utf8');

function frame(first, body) {
  const len = [];
  let n = body.length;
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n) d |= 128;
    len.push(d);
  } while (n);
  return Buffer.concat([Buffer.from([first, ...len]), body]);
}

function topicMatches(filter, topic) {
  if (filter.endsWith('/#')) return topic.startsWith(filter.slice(0, -1));
  return filter === topic;
}

class BrokerCore {
  constructor() {
    this.retained = new Map(); // topic -> Buffer payload
    this.conns = new Set();
    this.log = []; // [direction, topic] for assertions
  }

  /** `send(Buffer)` and `close()` come from the transport. */
  connect(send, close) {
    const conn = { send, close, subs: [], will: null, buf: Buffer.alloc(0), clean: false, id: null };
    this.conns.add(conn);
    return {
      onData: (data) => this._data(conn, Buffer.from(data)),
      onClose: () => this._closed(conn),
    };
  }

  dropAll() {
    for (const c of [...this.conns]) c.close();
  }

  _data(conn, data) {
    conn.buf = Buffer.concat([conn.buf, data]);
    for (;;) {
      if (conn.buf.length < 2) return;
      let i = 1, mult = 1, len = 0, d;
      do {
        if (i >= conn.buf.length) return;
        d = conn.buf[i++];
        len += (d & 127) * mult;
        mult *= 128;
      } while (d & 128);
      if (conn.buf.length < i + len) return;
      const first = conn.buf[0];
      const body = conn.buf.subarray(i, i + len);
      conn.buf = conn.buf.subarray(i + len);
      this._packet(conn, first, body);
    }
  }

  _packet(conn, first, body) {
    const type = first >> 4;
    if (type === 1) {
      let p = 0;
      const rs = () => {
        const l = body.readUInt16BE(p);
        const s = body.subarray(p + 2, p + 2 + l);
        p += 2 + l;
        return s;
      };
      rs(); // protocol name
      p += 1; // level
      const flags = body[p++];
      p += 2; // keepalive
      conn.id = utf8(rs());
      if (flags & 0x04) conn.will = { topic: utf8(rs()), payload: Buffer.from(rs()), retain: !!(flags & 0x20) };
      conn.send(Buffer.from([0x20, 2, 0, 0]));
    } else if (type === 8) {
      const id = body.readUInt16BE(0);
      const tl = body.readUInt16BE(2);
      const filter = utf8(body.subarray(4, 4 + tl));
      conn.subs.push(filter);
      conn.send(Buffer.from([0x90, 3, id >> 8, id & 255, 0]));
      for (const [topic, payload] of this.retained) {
        if (topicMatches(filter, topic)) conn.send(this._publishPacket(topic, payload, true));
      }
    } else if (type === 3) {
      const tl = body.readUInt16BE(0);
      const topic = utf8(body.subarray(2, 2 + tl));
      this._route(topic, Buffer.from(body.subarray(2 + tl)), !!(first & 1), conn);
    } else if (type === 12) {
      conn.send(Buffer.from([0xd0, 0]));
    } else if (type === 14) {
      conn.clean = true;
      conn.will = null;
      conn.close();
    }
  }

  _publishPacket(topic, payload, retain) {
    const t = Buffer.from(topic);
    const head = Buffer.alloc(2);
    head.writeUInt16BE(t.length);
    return frame(0x30 | (retain ? 1 : 0), Buffer.concat([head, t, payload]));
  }

  _route(topic, payload, retain, from) {
    this.log.push([from && from.id, topic]);
    if (retain) {
      if (payload.length) this.retained.set(topic, payload);
      else this.retained.delete(topic);
    }
    for (const c of this.conns) {
      if (c.subs.some((f) => topicMatches(f, topic))) c.send(this._publishPacket(topic, payload, false));
    }
  }

  _closed(conn) {
    if (!this.conns.delete(conn)) return;
    if (conn.will && !conn.clean) this._route(conn.will.topic, conn.will.payload, conn.will.retain, conn);
  }
}

/** Real WebSocket (RFC 6455) server on localhost; resolves to {url, broker, close}. */
function startWebSocketBroker() {
  const broker = new BrokerCore();
  const server = http.createServer((req, res) => res.end('mini-broker'));
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: mqtt\r\n\r\n`);
    sockets.add(socket);
    const send = (buf) => {
      if (socket.destroyed) return;
      const n = buf.length;
      const head = n < 126 ? Buffer.from([0x82, n]) : Buffer.from([0x82, 126, n >> 8, n & 255]);
      socket.write(Buffer.concat([head, buf]));
    };
    const conn = broker.connect(send, () => socket.destroy());
    let acc = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk]);
      for (;;) {
        if (acc.length < 2) return;
        const opcode = acc[0] & 15;
        let len = acc[1] & 127;
        let off = 2;
        if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
        if (acc.length < off + 4 + len) return;
        const mask = acc.subarray(off, off + 4);
        const payload = Buffer.from(acc.subarray(off + 4, off + 4 + len));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        acc = acc.subarray(off + 4 + len);
        if (opcode === 8) { socket.destroy(); return; }
        if (opcode === 2) conn.onData(payload);
      }
    });
    socket.on('close', () => { sockets.delete(socket); conn.onClose(); });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `ws://127.0.0.1:${server.address().port}/`,
        broker,
        close: () => new Promise((done) => {
          for (const s of sockets) s.destroy();
          server.close(done);
        }),
      });
    });
  });
}

/** Back a Playwright WebSocketRoute with the broker (no network needed). */
function attachToRoute(broker, route) {
  const conn = broker.connect(
    (buf) => route.send(buf),
    () => route.close()
  );
  route.onMessage((m) => conn.onData(typeof m === 'string' ? Buffer.from(m) : m));
  route.onClose(() => conn.onClose());
}

module.exports = { BrokerCore, startWebSocketBroker, attachToRoute };
