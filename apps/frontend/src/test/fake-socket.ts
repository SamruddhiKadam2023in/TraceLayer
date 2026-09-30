import type { SubscribeAck } from '@tracelayer/shared';

type Handler = (...args: unknown[]) => void;

/**
 * Stand-in for a socket.io-client socket. Nothing happens until a test drives it: the
 * `server*` methods play the server's part (accept, reject, drop, push events).
 */
export class FakeSocket {
  connected = false;
  /** What `subscribe` answers; tests can change it. */
  subscribeAck: (workspaceId: string) => SubscribeAck = () => ({ ok: true });
  readonly subscriptions: string[] = [];
  connectCalls = 0;
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();

  constructor(readonly options: { auth?: (cb: (data: object) => void) => void }) {}

  /** The auth payload the client would send now. */
  authPayload(): object {
    let payload: object = {};
    this.options.auth?.((data) => (payload = data));
    return payload;
  }

  on(event: string, handler: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return this;
  }
  onAny(handler: Handler) {
    this.anyHandlers.add(handler);
    return this;
  }
  removeAllListeners() {
    this.handlers.clear();
    this.anyHandlers.clear();
    return this;
  }
  emit(event: string, ...args: unknown[]) {
    if (event === 'subscribe') {
      const [workspaceId, ack] = args as [string, (a: SubscribeAck) => void];
      this.subscriptions.push(workspaceId);
      ack(this.subscribeAck(workspaceId));
    }
    return this;
  }
  connect() {
    this.connectCalls++;
    return this;
  }
  disconnect() {
    this.connected = false;
    return this;
  }

  private fire(event: string, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  serverAccept() {
    this.connected = true;
    this.fire('connect');
  }
  serverReject(message: string) {
    this.fire('connect_error', new Error(message));
  }
  serverDrop(reason = 'transport close') {
    this.connected = false;
    this.fire('disconnect', reason);
  }
  serverEmit(event: string, payload: unknown) {
    for (const handler of this.anyHandlers) handler(event, payload);
  }
}

export const fakeSockets: FakeSocket[] = [];

/** The socket the app opened most recently. */
export function latestSocket(): FakeSocket {
  const socket = fakeSockets.at(-1);
  if (!socket) throw new Error('the app has not opened a socket');
  return socket;
}
