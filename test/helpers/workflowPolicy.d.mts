export interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
  [propertyName: string]: unknown;
}

export interface WorkflowRunStep extends WorkflowStep {
  run: string;
}

export interface WorkflowJob {
  environment?: string;
  permissions?: Record<string, string>;
  needs?: string | string[];
  concurrency?: Record<string, unknown>;
  if?: string;
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
  [propertyName: string]: unknown;
}

export interface Workflow {
  jobs: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  [propertyName: string]: unknown;
}

export interface WorkflowActionReference {
  action: string;
  ref: string;
}

export function readWorkflow(workflowPath: string): Workflow;
export function workflowJob(workflow: Workflow, jobName: string): WorkflowJob;
export function workflowStep(
  job: WorkflowJob,
  stepName: string,
): WorkflowRunStep;
export function workflowRun(job: WorkflowJob, stepName: string): string;
export function workflowActionReferences(
  workflow: Workflow,
): WorkflowActionReference[];
export function isRecord(
  candidateValue: unknown,
): candidateValue is Record<string, unknown>;
