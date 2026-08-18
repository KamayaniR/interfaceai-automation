/**
 * Chat sessions — the conversation history behind the dashboard.
 *
 * Two decisions worth stating.
 *
 * **A chat session is not a browser session.** They have different lifetimes and
 * different owners: a conversation spans days and many capability invocations, while a
 * browser session belongs to one replay run and holds live auth cookies. Conflating them
 * — one `sessionId` for both — breaks the moment a chat triggers a second capability.
 * They are linked by reference (`runId`), never merged.
 *
 * **Messages carry links, not just prose.** A history that records "I looked up member
 * 100442" and nothing else is unusable for the thing history is actually for: going back
 * and asking what happened. Every assistant message that ran something carries the
 * `runId`, `capabilityId` and result, so the UI can offer the run log and the artifact
 * that produced it.
 *
 * Storage is append-only JSONL, the same shape as `run.jsonl` — a conversation is an
 * event log, and rewriting a whole file to add one message is how you lose messages.
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReplayResult } from '../schema/result.ts';

export type MessageRole = 'user' | 'assistant' | 'system' | 'operator';

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
  at: string;
  /** What this message refers to, so the UI can link back to evidence. */
  refs?: {
    runId?: string;
    capabilityId?: string;
    capabilityVersion?: number;
    status?: ReplayResult['status'];
    outcomeCode?: string;
    interventionId?: string;
    /** Set on a "nothing matches" message so the UI can offer to record one. */
    offerDiscovery?: string;
    /**
     * How the route was decided and what each half cost. Kept on the message rather than
     * derived later, because "this one needed a model and that one did not" is a property
     * of the turn, and a history that loses it cannot answer the question the design is
     * built around.
     */
    routeSource?: 'model' | 'cache';
    routeMs?: number;
    replayMs?: number;
  };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class SessionStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private path(id: string): string {
    return join(this.dir, `${id}.jsonl`);
  }

  create(): string {
    const id = randomUUID().slice(0, 8);
    appendFileSync(this.path(id), '');
    return id;
  }

  append(sessionId: string, role: MessageRole, content: string, refs?: Message['refs']): Message {
    const message: Message = {
      id: randomUUID().slice(0, 8),
      role,
      content,
      at: new Date().toISOString(),
      refs,
    };
    appendFileSync(this.path(sessionId), JSON.stringify(message) + '\n');
    return message;
  }

  messages(sessionId: string): Message[] {
    const p = this.path(sessionId);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Message);
  }

  /** Newest first, titled from the first thing the user said. */
  list(): SessionMeta[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const id = f.replace(/\.jsonl$/, '');
        const msgs = this.messages(id);
        const first = msgs.find((m) => m.role === 'user');
        return {
          id,
          title: first ? first.content.slice(0, 60) : 'New conversation',
          createdAt: msgs[0]?.at ?? new Date().toISOString(),
          updatedAt: msgs.at(-1)?.at ?? new Date().toISOString(),
          messageCount: msgs.length,
        };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
