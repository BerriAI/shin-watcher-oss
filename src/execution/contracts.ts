import type {
  ArtifactKind,
  ExecutionPhase,
  ExecutionTaskType,
} from "./types.js";

const PHASE_ORDER: ExecutionPhase[] = [
  "queued",
  "investigating",
  "implementing",
  "verifying",
  "publishing",
  "no_action_taken",
  "done",
  "failed",
];

const REQUIRED_ARTIFACTS: Record<ExecutionTaskType, ArtifactKind[]> = {
  repro_only: ["report_written", "screenshot_before"],
  fix_pr: ["report_written", "screenshot_before", "pr_url"],
  github_action: ["github_update"],
  ops_action: ["ops_ack"],
};

function rank(phase: ExecutionPhase): number {
  return PHASE_ORDER.indexOf(phase);
}

export function canTransitionPhase(
  from: ExecutionPhase,
  to: ExecutionPhase
): boolean {
  if (from === "failed" || from === "done") return false;
  if (to === "failed") return true;
  if (to === from) return true;
  const fromRank = rank(from);
  const toRank = rank(to);
  if (fromRank === -1 || toRank === -1) return false;
  return toRank >= fromRank && to !== "queued";
}

export function requiredArtifactsForTask(
  taskType: ExecutionTaskType
): ArtifactKind[] {
  return REQUIRED_ARTIFACTS[taskType];
}

export function missingRequiredArtifacts(
  taskType: ExecutionTaskType,
  artifactKinds: Iterable<ArtifactKind>
): ArtifactKind[] {
  const existing = new Set(artifactKinds);
  return REQUIRED_ARTIFACTS[taskType].filter((k) => !existing.has(k));
}

export function isTerminallyComplete(args: {
  taskType: ExecutionTaskType;
  phase: ExecutionPhase;
  artifactKinds: Iterable<ArtifactKind>;
}): { ok: boolean; missing: ArtifactKind[] } {
  if (args.phase !== "done" && args.phase !== "no_action_taken") {
    return { ok: false, missing: [] };
  }
  const existing = new Set(args.artifactKinds);
  const missing =
    args.taskType === "fix_pr" && args.phase === "no_action_taken"
      ? (["report_written", "no_action_reason"] as ArtifactKind[]).filter(
          (k) => !existing.has(k)
        )
      : missingRequiredArtifacts(args.taskType, existing);
  if (args.taskType === "fix_pr") {
    if (args.phase === "no_action_taken") {
      return { ok: missing.length === 0, missing };
    }
    // For blocked draft PRs, either validated after-shot OR explicit blocker metadata is required.
    if (!existing.has("screenshot_after") && !existing.has("proof_blocked")) {
      missing.push("screenshot_after");
    }
  }
  return { ok: missing.length === 0, missing };
}

export function classifyTaskType(input: string): ExecutionTaskType | null {
  const text = input.toLowerCase();
  if (
    /^\s*(hi|hello|hey|thanks|thank you|good morning|good afternoon)\b/.test(
      text
    ) ||
    /\b(what is|how does|explain|help me understand|brainstorm|design)\b/.test(
      text
    )
  ) {
    return null;
  }
  if (
    /\b(repro|reproduce|investigate|debug)\b/.test(text) ||
    /github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/i.test(input) ||
    /\bissue\s*#?\s*\d+\b/.test(text)
  ) {
    if (/\b(fix|pr|pull request|file a fix pr|open pr|patch)\b/.test(text)) {
      return "fix_pr";
    }
    return "repro_only";
  }
  if (/\b(comment|label|triage|close issue|reopen issue)\b/.test(text)) {
    return "github_action";
  }
  if (/\b(interrupt|rerun|retry|steer|resume)\b/.test(text)) {
    return "ops_action";
  }
  // Default to fix_pr for actionable issue-like free-form requests.
  if (text.trim().length > 0) return "fix_pr";
  return null;
}
