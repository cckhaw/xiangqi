/*
 * Xiangqi network layer for Internet play. No server of our own: two players
 * rendezvous on a free public MQTT broker (MQTT 3.1.1 over WebSocket).
 *
 *  - The challenge code never leaves the devices. A room topic and an
 *    AES-GCM key are both derived from it, so the broker (and anyone else
 *    watching) sees only an opaque topic and ciphertext, and nobody without
 *    the code can read, forge or tamper with a message.
 *  - A tiny MQTT client (QoS 0, retained messages, last-will) is implemented
 *    here, so there is no library to download or cache.
 *
 * Runs in the browser (window.XQNet) and in Node (module.exports).
 */
(function (root) {
  'use strict';

  /* Public brokers with TLS WebSocket endpoints, tried in order. Each must
   * also appear in the Content-Security-Policy `connect-src` in vercel.json
   * (tests/pwa.test.js checks this). */
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/',
  ];

  const ROOT_TOPIC = 'xqpwa/1/';
  const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no I L O 0 1
  const CODE_LENGTH = 6;

  const subtle = () => {
    const c = root.crypto || (typeof require === 'function' ? require('node:crypto').webcrypto : null);
    if (!c || !c.subtle) throw new Error('Secure context required');
    return c;
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ------------------------------------------------------------ codes */

  /** A random challenge code like "K7M4PQ" (31^6, about 887 million). */
  function genCode() {
    const c = subtle();
    let out = '';
    const limit = 256 - (256 % CODE_ALPHABET.length); // rejection sampling: no modulo bias
    const buf = new Uint8Array(32);
    while (out.length < CODE_LENGTH) {
      c.getRandomValues(buf);
      for (const byte of buf) {
        if (byte < limit && out.length < CODE_LENGTH) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      }
    }
    return out;
  }

  /** Normalise what a person typed or pasted ("k7m-4pq" -> "K7M4PQ"), or null if invalid. */
  function normCode(text) {
    const code = String(text || '').toUpperCase().replace(/[\s-]/g, '');
    if (code.length !== CODE_LENGTH) return null;
    for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
    return code;
  }

  const prettyCode = (code) => code.slice(0, 3) + '-' + code.slice(3);

  function randomId() {
    const bytes = new Uint8Array(8);
    subtle().getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ----------------------------------------------------------- crypto */

  const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  function b64encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64decode(text) {
    const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  /** Derive the room's public topic and its secret AES-GCM key from the code. */
  async function deriveRoom(code) {
    const { subtle: sub } = subtle();
    const digest = new Uint8Array(await sub.digest('SHA-256', enc.encode('xiangqi-topic:' + code)));
    const material = await sub.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
    const key = await sub.deriveKey(
      { name: 'PBKDF2', salt: enc.encode('xiangqi-pwa-v1'), iterations: 100000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    return { topic: ROOT_TOPIC + toHex(digest.subarray(0, 10)), key };
  }

  async function seal(key, obj) {
    const c = subtle();
    const iv = c.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    return b64encode(out);
  }

  /** Decrypt a sealed message; null if it is not ours or was tampered with. */
  async function open(key, text) {
    try {
      const bytes = b64decode(text);
      if (bytes.length < 29) return null;
      const plain = await subtle().subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
      return JSON.parse(dec.decode(plain));
    } catch (err) {
      return null;
    }
  }

  /* -------------------------------------------------------------- MQTT */

  const T = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 };

  const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
  const str = (s) => {
    const b = enc.encode(s);
    return [...u16(b.length), ...b];
  };

  function packet(typeAndFlags, body) {
    const len = [];
    let n = body.length;
    do {
      let digit = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) digit |= 0x80;
      len.push(digit);
    } while (n > 0);
    return Uint8Array.from([typeAndFlags, ...len, ...body]);
  }

  const mqtt = {
    T,
    connect({ clientId, keepalive = 30, will }) {
      // Protocol "MQTT" level 4 (3.1.1); clean session, optional retained will.
      let flags = 0x02;
      if (will) flags |= 0x04 | 0x20; // will flag + will retain (QoS 0)
      const body = [...str('MQTT'), 4, flags, ...u16(keepalive), ...str(clientId)];
      if (will) body.push(...str(will.topic), ...u16(will.payload.length), ...enc.encode(will.payload));
      return packet(T.CONNECT << 4, body);
    },
    subscribe(id, topicFilter) {
      return packet((T.SUBSCRIBE << 4) | 0x02, [...u16(id), ...str(topicFilter), 0]);
    },
    publish(topic, text, retain) {
      return packet((T.PUBLISH << 4) | (retain ? 1 : 0), [...str(topic), ...enc.encode(text)]);
    },
    pingreq: () => Uint8Array.from([T.PINGREQ << 4, 0]),
    disconnect: () => Uint8Array.from([T.DISCONNECT << 4, 0]),

    /** Incremental decoder: feed(bytes) returns the complete packets so far. */
    decoder() {
      let buf = new Uint8Array(0);
      return {
        feed(chunk) {
          const merged = new Uint8Array(buf.length + chunk.length);
          merged.set(buf);
          merged.set(chunk, buf.length);
          buf = merged;
          const out = [];
          for (;;) {
            if (buf.length < 2) break;
            let mult = 1;
            let len = 0;
            let i = 1;
            let digit;
            do {
              if (i >= buf.length) return out; // length bytes incomplete
              digit = buf[i++];
              len += (digit & 127) * mult;
              mult *= 128;
              if (mult > 128 * 128 * 128 * 128) throw new Error('Malformed MQTT length');
            } while (digit & 128);
            if (buf.length < i + len) break;
            out.push(parse(buf[0], buf.subarray(i, i + len)));
            buf = buf.subarray(i + len);
          }
          return out;
        },
      };
    },
  };

  function parse(first, body) {
    const type = first >> 4;
    const pkt = { type, flags: first & 15 };
    if (type === T.PUBLISH) {
      const tl = (body[0] << 8) | body[1];
      pkt.topic = dec.decode(body.subarray(2, 2 + tl));
      let at = 2 + tl;
      if ((first >> 1) & 3) at += 2; // packet id, only present for QoS > 0
      pkt.retain = !!(first & 1);
      pkt.text = dec.decode(body.subarray(at));
    } else if (type === T.CONNACK) {
      pkt.code = body[1];
    } else if (type === T.CONNECT) {
      pkt.body = body;
    } else if (type === T.SUBSCRIBE) {
      pkt.id = (body[0] << 8) | body[1];
      const tl = (body[2] << 8) | body[3];
      pkt.filter = dec.decode(body.subarray(4, 4 + tl));
    }
    return pkt;
  }

  /* -------------------------------------------------------------- Link */

  /**
   * One encrypted, auto-reconnecting channel to a room.
   *
   *   const link = new Link({ code, clientId, onMessage, onStatus });
   *   await link.start();
   *   link.publish('h', { ...state });          // retained, replaces the previous one
   *   link.notify('p/ID', { on: true }, true);  // any sub-topic
   *
   * onMessage(subTopic, object) gets every decrypted message in the room,
   * including retained ones delivered when (re)connecting. Retained messages
   * are re-sent after each reconnect, so the latest state is never lost.
   */
  class Link {
    constructor({ code, clientId, onMessage, onStatus, brokers = BROKERS, WebSocketImpl, will, keepalive = 30 }) {
      this.code = code;
      this.clientId = 'xq-' + clientId;
      this.onMessage = onMessage || (() => {});
      this.onStatus = onStatus || (() => {});
      this.brokers = brokers;
      this.WS = WebSocketImpl || root.WebSocket;
      this.willSpec = will || null; // { sub, obj }
      this.keepalive = keepalive;
      this.status = 'connecting';
      this.stopped = false;
      this.attempt = 0;
      this.retained = new Map(); // subTopic -> sealed text, replayed after reconnects
      this.ws = null;
      this.ready = false;
      this.lastRx = 0;
    }

    async start() {
      this.room = await deriveRoom(this.code);
      this.willPayload = this.willSpec ? await seal(this.room.key, this.willSpec.obj) : null;
      this._connect();
    }

    _setStatus(status) {
      if (this.status !== status) {
        this.status = status;
        this.onStatus(status);
      }
    }

    _connect() {
      if (this.stopped) return;
      this._setStatus(this.attempt === 0 || this.status === 'connecting' ? 'connecting' : 'offline');
      const url = this.brokers[this.attempt % this.brokers.length];
      let ws;
      try {
        ws = new this.WS(url, 'mqtt');
      } catch (err) {
        this._retry();
        return;
      }
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      this.ready = false;
      const decoder = mqtt.decoder();
      let timer = 0;

      ws.onopen = () => {
        const will = this.willSpec ? { topic: this.room.topic + '/' + this.willSpec.sub, payload: this.willPayload } : null;
        ws.send(mqtt.connect({ clientId: this.clientId, keepalive: this.keepalive, will }));
        // Give up on a broker that accepts the socket but never answers.
        timer = setTimeout(() => ws.close(), 10000);
      };
      ws.onmessage = (event) => {
        this.lastRx = Date.now();
        let packets;
        try {
          packets = decoder.feed(new Uint8Array(event.data));
        } catch (err) {
          ws.close();
          return;
        }
        for (const pkt of packets) {
          if (pkt.type === T.CONNACK) {
            clearTimeout(timer);
            if (pkt.code !== 0) {
              ws.close();
              return;
            }
            this.ready = true;
            this.attempt = 0;
            ws.send(mqtt.subscribe(1, this.room.topic + '/#'));
            for (const [sub, text] of this.retained) ws.send(mqtt.publish(this.room.topic + '/' + sub, text, true));
            this._beat();
            this._setStatus('online');
          } else if (pkt.type === T.PUBLISH) {
            this._receive(pkt);
          }
        }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        if (this.ws === ws) {
          this.ws = null;
          this.ready = false;
          clearInterval(this.beatTimer);
          this._retry();
        }
      };
      ws.onerror = () => {}; // onclose always follows
    }

    _beat() {
      clearInterval(this.beatTimer);
      this.lastRx = Date.now();
      this.beatTimer = setInterval(() => {
        if (!this.ws || !this.ready) return;
        if (Date.now() - this.lastRx > this.keepalive * 2500) {
          this.ws.close(); // half-dead connection (common on mobile networks)
          return;
        }
        this.ws.send(mqtt.pingreq());
      }, (this.keepalive * 1000) / 2);
    }

    async _receive(pkt) {
      const prefix = this.room.topic + '/';
      if (!pkt.topic.startsWith(prefix)) return;
      const obj = await open(this.room.key, pkt.text);
      if (obj) this.onMessage(pkt.topic.slice(prefix.length), obj, !!pkt.retain);
    }

    _retry() {
      if (this.stopped) return;
      this._setStatus('offline');
      this.attempt += 1;
      clearTimeout(this.retryTimer);
      // First retries are quick (try the next broker), then back off.
      const delay = Math.min(15000, 600 * Math.pow(1.8, Math.min(this.attempt, 8)));
      this.retryTimer = setTimeout(() => this._connect(), delay);
    }

    /** Reconnect now if the socket is down (call when the app returns to the foreground). */
    nudge() {
      if (this.stopped) return;
      if (this.ws && this.ready && Date.now() - this.lastRx < this.keepalive * 1500) return;
      if (this.ws) {
        try {
          this.ws.close();
        } catch (err) {
          /* already closing */
        }
        return; // onclose schedules the retry
      }
      clearTimeout(this.retryTimer);
      this._connect();
    }

    async publish(sub, obj, retain = true) {
      const text = await seal(this.room.key, obj);
      if (retain) this.retained.set(sub, text);
      if (this.ws && this.ready) this.ws.send(mqtt.publish(this.room.topic + '/' + sub, text, retain));
    }

    close(graceful = true) {
      this.stopped = true;
      clearTimeout(this.retryTimer);
      clearInterval(this.beatTimer);
      const ws = this.ws;
      this.ws = null;
      if (ws) {
        try {
          if (graceful && this.ready) ws.send(mqtt.disconnect());
          ws.close();
        } catch (err) {
          /* already closed */
        }
      }
      this._setStatus('closed');
    }
  }

  const api = { BROKERS, genCode, normCode, prettyCode, randomId, deriveRoom, seal, open, mqtt, Link, CODE_ALPHABET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XQNet = api;
})(typeof self !== 'undefined' ? self : this);
