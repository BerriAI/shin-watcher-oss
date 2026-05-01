import { EventEmitter } from "node:events";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { CandidateIssue } from "../picker.js";

export interface ActiveRun {
  taskId: string;
  issue: CandidateIssue;
  agent: Agent;
  startedAt: number;
}

export interface LiveEvent {
  taskId: string;
  event: AgentEvent & { ts: number };
}

class LiveBusImpl extends EventEmitter {
  private activeRuns = new Map<string, ActiveRun>();

  startRun(taskId: string, issue: CandidateIssue, agent: Agent): void {
    const startedAt = Date.now();
    this.activeRuns.set(taskId, { taskId, issue, agent, startedAt });
    this.emit("run_start", {
      taskId,
      issueNumber: issue.number,
      issueTitle: issue.title,
      issueUrl: issue.htmlUrl,
      startedAt,
    });
  }

  endRun(taskId: string): void {
    this.activeRuns.delete(taskId);
    this.emit("run_end", { taskId });
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
}

export const LiveBus = new LiveBusImpl();
