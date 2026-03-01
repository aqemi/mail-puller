import { connect } from 'cloudflare:sockets';

export interface EmailMessage {
  uid: number;
  from: string;
  subject: string;
  date: string;
}

// ── Byte-level line reader ───────────────────────────────────────────────────

/**
 * Reads lines and raw byte slices from a ReadableStream<Uint8Array>.
 * Uses a Uint8Array buffer so that literal byte counts (from IMAP {n} markers)
 * are exact regardless of multi-byte UTF-8 characters.
 */
class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf: Uint8Array = new Uint8Array(0);
  private dec = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

  constructor(readable: ReadableStream) {
    this.reader = (readable as ReadableStream<Uint8Array>).getReader();
  }

  private append(chunk: Uint8Array): void {
    const next = new Uint8Array(this.buf.length + chunk.length);
    next.set(this.buf);
    next.set(chunk, this.buf.length);
    this.buf = next;
  }

  async readLine(): Promise<string> {
    while (true) {
      for (let i = 0; i + 1 < this.buf.length; i++) {
        if (this.buf[i] === 0x0d && this.buf[i + 1] === 0x0a) {
          const line = this.dec.decode(this.buf.subarray(0, i));
          this.buf = this.buf.slice(i + 2);
          return line;
        }
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error('IMAP: connection closed unexpectedly');
      this.append(value);
    }
  }

  /** Read exactly n raw bytes, returned as a decoded string */
  async readBytes(n: number): Promise<string> {
    while (this.buf.length < n) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('IMAP: connection closed while reading literal');
      this.append(value);
    }
    const result = this.dec.decode(this.buf.subarray(0, n));
    this.buf = this.buf.slice(n);
    return result;
  }
}

// ── IMAP client ──────────────────────────────────────────────────────────────

export class ImapClient {
  private lr!: LineReader;
  private writer!: WritableStreamDefaultWriter<Uint8Array>;
  private socket!: Socket;
  private seq = 0;
  private enc = new TextEncoder();

  async connect(host: string, port: number): Promise<void> {
    this.socket = connect(`${host}:${port}`, { secureTransport: 'on', allowHalfOpen: false });
    this.lr = new LineReader(this.socket.readable);
    this.writer = (this.socket.writable as WritableStream<Uint8Array>).getWriter();

    const greeting = await this.lr.readLine();
    if (!greeting.startsWith('* OK') && !greeting.startsWith('* PREAUTH')) {
      throw new Error(`Unexpected IMAP greeting: ${greeting}`);
    }
  }

  private tag(): string {
    return `T${String(++this.seq).padStart(4, '0')}`;
  }

  private async send(cmd: string): Promise<string> {
    const t = this.tag();
    await this.writer.write(this.enc.encode(`${t} ${cmd}\r\n`));
    return t;
  }

  /**
   * Read server lines until the given tag is acknowledged.
   * IMAP literal blocks `{n}` are inlined as double-quoted strings so the
   * returned text can be fed directly into parseImapList().
   */
  private async readResponse(tag: string): Promise<string> {
    let result = '';
    while (true) {
      const line = await this.lr.readLine();
      const litMatch = line.match(/\{(\d+)\}$/);
      if (litMatch) {
        const n = parseInt(litMatch[1]);
        const literal = await this.lr.readBytes(n);
        // Inline as a quoted string so the list parser can consume it
        const escaped = literal.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        result += line.replace(/\{\d+\}$/, `"${escaped}"`) + '\r\n';
      } else {
        result += line + '\r\n';
        if (line.startsWith(`${tag} `)) {
          if (!line.startsWith(`${tag} OK`)) {
            throw new Error(`IMAP command failed: ${line.slice(tag.length + 1)}`);
          }
          return result;
        }
      }
    }
  }

  async login(user: string, pass: string): Promise<void> {
    const eu = user.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const ep = pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const t = await this.send(`LOGIN "${eu}" "${ep}"`);
    await this.readResponse(t);
  }

  /**
   * SELECT INBOX.
   * Returns the current maximum UID (UIDNEXT − 1), or 0 if the mailbox is empty.
   */
  async selectInbox(): Promise<number> {
    const t = await this.send('SELECT INBOX');
    const response = await this.readResponse(t);
    const m = response.match(/\* OK \[UIDNEXT (\d+)\]/i);
    return m ? parseInt(m[1]) - 1 : 0;
  }

  /** Returns UIDs of messages with UID > lastUid */
  async searchUidSince(lastUid: number): Promise<number[]> {
    const t = await this.send(`UID SEARCH UID ${lastUid + 1}:*`);
    const response = await this.readResponse(t);
    const line = response.split('\r\n').find((l) => l.startsWith('* SEARCH'));
    if (!line) return [];
    return line
      .split(' ')
      .slice(2)
      .map(Number)
      .filter((n) => !isNaN(n) && n > 0 && n > lastUid);
  }

  /** Fetch ENVELOPE for the given UIDs */
  async fetchMessages(uids: number[]): Promise<EmailMessage[]> {
    if (uids.length === 0) return [];
    const t = await this.send(`UID FETCH ${uids.join(',')} (UID ENVELOPE)`);
    const response = await this.readResponse(t);
    return parseFetchResponse(response);
  }

  async logout(): Promise<void> {
    try {
      const t = await this.send('LOGOUT');
      await this.readResponse(t);
    } catch {
      // ignore — we're closing anyway
    }
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }
}

// ── FETCH response parser ────────────────────────────────────────────────────

function parseFetchResponse(response: string): EmailMessage[] {
  const messages: EmailMessage[] = [];
  let pos = 0;

  while (pos < response.length) {
    const fetchIdx = response.indexOf('* ', pos);
    if (fetchIdx === -1) break;

    const slice = response.slice(fetchIdx);
    const fetchMatch = slice.match(/^\* \d+ FETCH \(/);
    if (!fetchMatch) {
      pos = fetchIdx + 2;
      continue;
    }

    // Position of the opening '(' of the FETCH data list
    const parenPos = fetchIdx + fetchMatch[0].length - 1;
    const parsePos = { i: parenPos };

    try {
      const data = parseImapList(response, parsePos);
      pos = parsePos.i;

      if (!Array.isArray(data)) continue;

      // Convert flat alternating [key, val, key, val, ...] into a map
      const map: Record<string, unknown> = {};
      for (let j = 0; j + 1 < data.length; j += 2) {
        map[String(data[j]).toUpperCase()] = data[j + 1];
      }

      const uid = parseInt(String(map['UID'] ?? '0'));
      const envelope = map['ENVELOPE'];

      if (uid && Array.isArray(envelope)) {
        const date = String(envelope[0] ?? '');
        const subject = String(envelope[1] ?? '') || '(no subject)';
        const from = extractAddress(envelope[2]);
        messages.push({ uid, date, subject, from });
      }
    } catch (err) {
      console.error('Failed to parse FETCH block:', err);
      pos = fetchIdx + fetchMatch[0].length;
    }
  }

  return messages;
}

function extractAddress(addrList: unknown): string {
  if (!Array.isArray(addrList) || !Array.isArray(addrList[0])) return '';
  const addr = addrList[0] as unknown[];
  const name = addr[0];
  const mailbox = addr[2];
  const host = addr[3];
  if (!mailbox || !host) return '';
  const email = `${mailbox}@${host}`;
  return name ? `${name} <${email}>` : email;
}

// ── Lightweight IMAP list (s-expression) parser ──────────────────────────────

/**
 * Parses an IMAP parenthesised list starting at pos.i.
 * Handles: quoted strings, NIL, nested lists, and atoms (including BODY[TEXT]<0>).
 * Literals must be pre-inlined as quoted strings before calling this function.
 */
function parseImapList(s: string, pos: { i: number }): unknown {
  skipWS(s, pos);
  if (pos.i >= s.length) return null;

  const ch = s[pos.i];

  if (ch === '(') {
    pos.i++; // consume '('
    const list: unknown[] = [];
    skipWS(s, pos);
    while (pos.i < s.length && s[pos.i] !== ')') {
      list.push(parseImapList(s, pos));
      skipWS(s, pos);
    }
    if (pos.i < s.length) pos.i++; // consume ')'
    return list;
  }

  if (ch === '"') {
    pos.i++; // consume opening '"'
    let str = '';
    while (pos.i < s.length && s[pos.i] !== '"') {
      if (s[pos.i] === '\\' && pos.i + 1 < s.length) {
        pos.i++;
        str += s[pos.i++];
      } else {
        str += s[pos.i++];
      }
    }
    if (pos.i < s.length) pos.i++; // consume closing '"'
    return str;
  }

  // Atom — stop at whitespace or list delimiters
  let atom = '';
  while (
    pos.i < s.length &&
    s[pos.i] !== ' ' &&
    s[pos.i] !== '\t' &&
    s[pos.i] !== '\r' &&
    s[pos.i] !== '\n' &&
    s[pos.i] !== '(' &&
    s[pos.i] !== ')'
  ) {
    atom += s[pos.i++];
  }
  return atom.toUpperCase() === 'NIL' ? null : atom;
}

function skipWS(s: string, pos: { i: number }): void {
  while (pos.i < s.length && (s[pos.i] === ' ' || s[pos.i] === '\t' || s[pos.i] === '\r' || s[pos.i] === '\n')) {
    pos.i++;
  }
}
