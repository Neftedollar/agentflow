import type { ChatMessage } from "./openai-types.js";

export interface SessionStore {
  get(handle: string): Promise<ChatMessage[] | undefined>;
  set(handle: string, messages: ChatMessage[]): Promise<void>;
  delete(handle: string): Promise<void>;
}

/**
 * Default session store. Map<handle, ChatMessage[]>, process-local.
 * Stores deep-cloned copies so external mutation of message objects
 * cannot silently rewrite recorded history (P1-4 fix).
 */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<string, ChatMessage[]>();

  async get(handle: string): Promise<ChatMessage[] | undefined> {
    const got = this.data.get(handle);
    return got ? structuredClone(got) : undefined;
  }

  async set(handle: string, messages: ChatMessage[]): Promise<void> {
    this.data.set(handle, structuredClone(messages));
  }

  async delete(handle: string): Promise<void> {
    this.data.delete(handle);
  }
}
