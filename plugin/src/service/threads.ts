/**
 * 线程持久化：本地 data.json 中保存 thread → ACP sessionId 的映射。
 */
import type { Plugin } from "obsidian";

export interface ThreadRecord {
  id: string;
  sessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreData {
  threads: ThreadRecord[];
  activeThreadId: string | null;
}

export class ThreadStore {
  private data: StoreData = { threads: [], activeThreadId: null };
  private loaded = false;

  constructor(private readonly plugin: Plugin) {}

  async load(): Promise<void> {
    const stored = (await this.plugin.loadData()) as Partial<StoreData> | null;
    this.data = {
      threads: Array.isArray(stored?.threads) ? stored!.threads : [],
      activeThreadId: typeof stored?.activeThreadId === "string" ? stored.activeThreadId : null,
    };
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.plugin.saveData(this.data);
  }

  list(): ThreadRecord[] {
    return [...this.data.threads].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): ThreadRecord | undefined {
    return this.data.threads.find((t) => t.id === id);
  }

  findBySession(sessionId: string): ThreadRecord | undefined {
    return this.data.threads.find((t) => t.sessionId === sessionId);
  }

  async create(id: string, sessionId: string, title: string): Promise<ThreadRecord> {
    const record: ThreadRecord = {
      id,
      sessionId,
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.data.threads.push(record);
    this.data.activeThreadId = id;
    await this.save();
    return record;
  }

  async touch(id: string): Promise<void> {
    const thread = this.get(id);
    if (!thread) return;
    thread.updatedAt = Date.now();
    await this.save();
  }

  async setTitle(id: string, title: string): Promise<void> {
    const thread = this.get(id);
    if (!thread) return;
    thread.title = title;
    await this.save();
  }

  async setSessionId(id: string, sessionId: string): Promise<void> {
    const thread = this.get(id);
    if (!thread) return;
    thread.sessionId = sessionId;
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.data.threads = this.data.threads.filter((t) => t.id !== id);
    if (this.data.activeThreadId === id) this.data.activeThreadId = this.data.threads[0]?.id ?? null;
    await this.save();
  }

  async setActive(id: string | null): Promise<void> {
    this.data.activeThreadId = id;
    await this.save();
  }

  get activeThreadId(): string | null {
    return this.data.activeThreadId;
  }
}
