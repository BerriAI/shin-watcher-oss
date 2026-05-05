export type ExecutionTaskType =
  | "repro_only"
  | "fix_pr"
  | "github_action"
  | "ops_action";

export type ExecutionPhase =
  | "queued"
  | "investigating"
  | "implementing"
  | "verifying"
  | "publishing"
  | "no_action_taken"
  | "done"
  | "failed";

export type ExecutionStatus = "running" | "recoverable" | "done" | "failed";

export type ArtifactKind =
  | "repro_started"
  | "report_written"
  | "screenshot_before"
  | "screenshot_after"
  | "proof_blocked"
  | "no_action_reason"
  | "gif"
  | "pr_url"
  | "github_comment"
  | "github_label"
  | "github_update"
  | "ops_ack";

export interface ExecutionRecord {
  executionId: string;
  sessionId: string;
  taskType: ExecutionTaskType;
  phase: ExecutionPhase;
  status: ExecutionStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface ExecutionArtifact {
  id: number;
  executionId: string;
  kind: ArtifactKind;
  value: string;
  sourceTool: string | null;
  createdAt: string;
}

export interface ExecutionCheckpoint {
  id: number;
  executionId: string;
  seq: number;
  phase: ExecutionPhase;
  summary: string;
  dataJson: string | null;
  createdAt: string;
}

export interface ExecutionSideEffect {
  id: number;
  executionId: string;
  effectKey: string;
  effectValue: string | null;
  createdAt: string;
}
