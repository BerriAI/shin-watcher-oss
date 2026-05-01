import { EventEmitter } from "node:events";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { CandidateIssue } from "../picker.js";

export interface ActiveRun {
  taskId: string;
  issue: CandidateIssue;
  agent: Agent;
  startedAt: number;
  /** Dashboard chat session that queued this run (browser-generated UUID). */
  chatSessionId?: string;
}

export interface LiveEvent {
  taskId: string;
  event: AgentEvent & { ts: number };
}

class LiveBusImpl extends EventEmitter {
  private activeRuns = new Map<string, ActiveRun>();

  startRun(
    taskId: string,
    issue: CandidateIssue,
    agent: Agent,
    chatSessionId?: string
  ): void {
    const startedAt = Date.now();
    this.activeRuns.set(taskId, {
      taskId,
      issue,
      agent,
      startedAt,
      chatSessionId,
    });
    this.emit("run_start", {
      taskId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.htmlUrl,
      startedAt,
      session_id: chatSessionId ?? null,
    });
  }

  endRun(taskId: string): void {
    const session_id = this.activeRuns.get(taskId)?.chatSessionId ?? null;
    this.activeRuns.delete(taskId);
    this.emit("run_end", { taskId, type: "run_end", session_id });
  }

  pushEvent(taskId: string, event: AgentEvent): void {
    const stamped = { ts: Date.now(), ...event };
    this.emit("agent_event", { taskId, event: stamped } satisfies LiveEvent);
  }

  getAgent(taskId: string): Agent | undefined {
    return this.activeRuns.get(taskId)?.agent;
  }

  getActiveRuns(): ActiveRun[] {
    return [...this.activeRuns.values()];
  }

  isActive(taskId: string): boolean {
    return this.activeRuns.has(taskId);
  }

  getChatSessionForTask(taskId: string): string | undefined {
    return this.activeRuns.get(taskId)?.chatSessionId;
  }
}

export const LiveBus = new LiveBusImpl();
