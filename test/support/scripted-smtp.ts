import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { type ParsedMail, simpleParser } from 'mailparser';

/*
 * Servidores SMTP simulados, sin TLS ni autenticación. `ScriptedSmtp` es el port de support/SmtpStub.java: acepta,
 * rechaza o corta según un guion por destinatario y guarda los mensajes que acepta. `startCannedSmtp` responde lo
 * que diga el guion a cada orden: es el de tools/golden-generator (DeliveryCases.CannedSmtp).
 */

interface Reply {
  kind: 'accept' | 'reject-recipient' | 'fail-data' | 'drop';
  code: number;
  text: string;
  delayMs: number;
}

export const SmtpReply = {
  accept: (): Reply => ({ kind: 'accept', code: 250, text: 'OK', delayMs: 0 }),
  /** El servidor rechaza al destinatario (respuesta a RCPT TO). */
  rejectRecipient: (code: number, text: string): Reply => ({ kind: 'reject-recipient', code, text, delayMs: 0 }),
  /** El servidor rechaza el mensaje después de recibirlo entero. */
  failData: (code: number, text: string): Reply => ({ kind: 'fail-data', code, text, delayMs: 0 }),
  /** Corta la conexión sin responder al mensaje. */
  dropConnection: (): Reply => ({ kind: 'drop', code: 0, text: '', delayMs: 0 }),
  /** Tarda en responder al mensaje. */
  delayed: (delayMs: number, reply: Reply): Reply => ({ ...reply, delayMs }),
};

/** Escucha en un puerto libre y entrega a `serve` cada conexión con sus líneas, sin el salto final. */
async function listen(
  serve: (socket: Socket, lines: AsyncIterator<string>) => Promise<void>,
): Promise<{ port: number; server: Server; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    void serve(socket, linesOf(socket))
      .catch(() => undefined)
      .finally(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

async function* linesOf(socket: Socket): AsyncGenerator<string, void, undefined> {
  let pending = '';
  for await (const chunk of socket) {
    pending += (chunk as Buffer).toString('latin1');
    for (let end = pending.indexOf('\r\n'); end >= 0; end = pending.indexOf('\r\n')) {
      yield pending.slice(0, end);
      pending = pending.slice(end + 2);
    }
  }
}

const say = (socket: Socket, reply: string) =>
  new Promise<void>((resolve) => socket.write(`${reply}\r\n`, 'utf8', () => resolve()));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Lee el mensaje hasta la línea con un solo punto, deshaciendo el relleno de puntos. */
async function readData(lines: AsyncIterator<string>): Promise<Buffer> {
  const message: string[] = [];
  for (;;) {
    const { value, done } = await lines.next();
    if (done === true || value === '.') return Buffer.from(message.join(''), 'latin1');
    message.push(`${value.startsWith('..') ? value.slice(1) : value}\r\n`);
  }
}

interface Mailbox {
  script: Reply[];
  messages: Buffer[];
}

export class ScriptedSmtp {
  private readonly mailboxes = new Map<string, Mailbox>();
  private opened = 0;
  private handle!: Awaited<ReturnType<typeof listen>>;

  static async start(): Promise<ScriptedSmtp> {
    const smtp = new ScriptedSmtp();
    smtp.handle = await listen((socket, lines) => smtp.serve(socket, lines));
    return smtp;
  }

  get port(): number {
    return this.handle.port;
  }

  /** Cada mensaje a esa dirección consume la siguiente respuesta; la última se repite. */
  onRecipient(email: string, ...replies: Reply[]): void {
    this.mailbox(email).script = [...replies];
  }

  /** Mensajes aceptados para esa dirección, tal como llegaron. */
  raw(email: string): Buffer[] {
    return [...this.mailbox(email).messages];
  }

  /** Mensajes aceptados para esa dirección, leídos, en orden de llegada. */
  messages(email: string): Promise<ParsedMail[]> {
    return Promise.all(this.raw(email).map((raw) => simpleParser(raw)));
  }

  /** Conexiones recibidas. */
  connections(): number {
    return this.opened;
  }

  close(): Promise<void> {
    return this.handle.close();
  }

  private mailbox(email: string): Mailbox {
    const key = email.toLowerCase();
    let box = this.mailboxes.get(key);
    if (box === undefined) {
      box = { script: [], messages: [] };
      this.mailboxes.set(key, box);
    }
    return box;
  }

  private next(email: string): Reply {
    const { script } = this.mailbox(email);
    return (script.length > 1 ? script.shift() : script[0]) ?? SmtpReply.accept();
  }

  private async serve(socket: Socket, lines: AsyncIterator<string>): Promise<void> {
    this.opened++;
    await say(socket, '220 smtp.stub ESMTP');
    let recipients: Array<{ address: string; reply: Reply }> = [];
    for (;;) {
      const { value: line, done } = await lines.next();
      if (done === true) return;
      const command = line.toUpperCase();
      if (command.startsWith('EHLO') || command.startsWith('HELO')) {
        await say(socket, '250 smtp.stub');
      } else if (command.startsWith('MAIL FROM')) {
        recipients = [];
        await say(socket, '250 OK');
      } else if (command.startsWith('RCPT TO')) {
        const address = line.slice(line.indexOf('<') + 1, line.indexOf('>'));
        const reply = this.next(address);
        if (reply.kind === 'reject-recipient') {
          await say(socket, `${reply.code} ${reply.text}`);
        } else {
          recipients.push({ address, reply });
          await say(socket, '250 OK');
        }
      } else if (command === 'DATA') {
        if (recipients.length === 0) {
          await say(socket, '503 No hay destinatarios');
          continue;
        }
        await say(socket, '354 Adelante');
        const raw = await readData(lines);
        const { reply } = recipients[0]!;
        if (reply.delayMs > 0) await sleep(reply.delayMs);
        if (reply.kind === 'drop') return;
        if (reply.kind === 'fail-data') {
          await say(socket, `${reply.code} ${reply.text}`);
        } else {
          for (const { address } of recipients) this.mailbox(address).messages.push(raw);
          await say(socket, '250 OK en cola');
        }
        recipients = [];
      } else if (command.startsWith('RSET') || command.startsWith('NOOP')) {
        await say(socket, '250 OK');
      } else if (command.startsWith('QUIT')) {
        await say(socket, '221 Adiós');
        return;
      } else {
        await say(socket, '500 Orden desconocida');
      }
    }
  }
}

const CANNED_DEFAULTS: Record<string, string> = {
  GREETING: '220 smtp.stub ESMTP',
  EHLO: '250 smtp.stub',
  HELO: '250 smtp.stub',
  MAIL: '250 OK',
  RCPT: '250 OK',
  DATA: '354 Adelante',
  END: '250 OK en cola',
};

/** Servidor que responde a cada orden lo que diga el guion; DROP corta la conexión y HANG no responde. */
export async function startCannedSmtp(
  script: Record<string, string>,
): Promise<{ port: number; messages: Buffer[]; close: () => Promise<void> }> {
  const messages: Buffer[] = [];
  const reply = (key: string) => script[key] ?? CANNED_DEFAULTS[key] ?? '500 Orden desconocida';
  const answer = async (socket: Socket, key: string): Promise<boolean> => {
    const text = reply(key);
    if (text === 'DROP') return false;
    if (text === 'HANG') {
      await sleep(5_000);
      return false;
    }
    await say(socket, text);
    return true;
  };
  const handle = await listen(async (socket, lines) => {
    if (!(await answer(socket, 'GREETING'))) return;
    for (;;) {
      const { value: line, done } = await lines.next();
      if (done === true) return;
      const command = line.toUpperCase();
      if (command.startsWith('QUIT')) {
        await say(socket, '221 Adios');
        return;
      }
      if (command.startsWith('RSET') || command.startsWith('NOOP')) {
        await say(socket, '250 OK');
        continue;
      }
      const key = ['EHLO', 'HELO', 'STARTTLS', 'AUTH', 'MAIL', 'RCPT', 'DATA'].find((name) => command.startsWith(name)) ?? '';
      if (!(await answer(socket, key))) return;
      if (key === 'DATA' && reply(key).startsWith('354')) {
        messages.push(await readData(lines));
        if (!(await answer(socket, 'END'))) return;
      }
    }
  });
  return { port: handle.port, messages, close: handle.close };
}
