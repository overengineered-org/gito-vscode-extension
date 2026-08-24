import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const repositoryRoot = resolve(import.meta.dirname, "../..");

export function readWorkflow(workflowPath) {
  const absoluteWorkflowPath = resolve(repositoryRoot, workflowPath);
  const parsedWorkflow = yaml.load(readFileSync(absoluteWorkflowPath, "utf8"));
  if (!isRecord(parsedWorkflow) || !isRecord(parsedWorkflow.jobs)) {
    throw new Error(`Workflow is missing a jobs map: ${workflowPath}`);
  }
  return parsedWorkflow;
}

export function workflowJob(workflow, jobName) {
  const job = workflow.jobs[jobName];
  if (!isRecord(job)) {
    throw new Error(`Workflow does not define job: ${jobName}`);
  }
  return job;
}

export function workflowStep(job, stepName) {
  const step = (Array.isArray(job.steps) ? job.steps : []).find(
    (candidateStep) =>
      isRecord(candidateStep) && candidateStep.name === stepName,
  );
  if (!step) {
    throw new Error(`Workflow job does not define step: ${stepName}`);
  }
  return step;
}

export function workflowRun(job, stepName) {
  const step = workflowStep(job, stepName);
  if (typeof step.run !== "string") {
    throw new Error(`Workflow step has no run script: ${stepName}`);
  }
  return step.run;
}

export function workflowActionReferences(workflow) {
  const actionReferences = [];
  for (const job of Object.values(workflow.jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    for (const step of job.steps) {
      if (!isRecord(step) || typeof step.uses !== "string") continue;
      const separatorIndex = step.uses.lastIndexOf("@");
      actionReferences.push({
        action: step.uses.slice(0, separatorIndex),
        ref: step.uses.slice(separatorIndex + 1),
      });
    }
  }
  return actionReferences;
}

export function isRecord(candidateValue) {
  return (
    candidateValue !== null &&
    typeof candidateValue === "object" &&
    !Array.isArray(candidateValue)
  );
}
