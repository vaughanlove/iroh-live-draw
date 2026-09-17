/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

export class Channel {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    id(): string;
    neighbors(): string[];
    ticket(opts: any): string;
    readonly receiver: ReadableStream;
    readonly sender: ChannelSender;
}

export class ChannelSender {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    broadcast(text: string): Promise<void>;
    set_nickname(nickname: string): void;
}

/**
 * Node for drawing together over iroh-gossip
 */
export class DrawNode {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Opens a drawing room.
     */
    create(nickname: string): Promise<Channel>;
    /**
     * Returns the endpoint id of this node.
     */
    endpoint_id(): string;
    /**
     * Joins a drawing room.
     */
    join(ticket: string, nickname: string): Promise<Channel>;
    /**
     * Our current home relay URL, if known yet. Included in tickets so
     * joiners can dial us without working discovery.
     */
    relay_url(): string | undefined;
    /**
     * Spawns a gossip node.
     */
    static spawn(): Promise<DrawNode>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

export function start(): void;
