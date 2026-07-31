/**
 * Subagents Orchestrator Extension
 *
 * Provides:
 * - `subagents` tool: Execute a DAG of tasks as isolated pi processes
 * - `/subagents` command: Format a prompt for the LLM to produce a task JSON
 * - `/subagents-model` command: Choose model for subagent processes
 *
 * Tasks execute in dependency order:
 * - Tasks with no dependencies run first
 * - Parallel tasks (same group) run simultaneously
 * - Context from dependency tasks is injected into subagent system prompts
 *
 * Each subagent is an isolated pi process. Its final output is captured
 * and returned to the parent process automatically.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, type SelectItem, SelectList } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TaskDefinition {
  id: number;
  context: number[];
  type: "unique" | "parallel";
  title: string;
  description: string;
}

interface TaskResult {
  task: TaskDefinition;
  output: string;
  error?: string;
  exitCode: number;
  startTime?: number;
  endTime?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cost: number;
    turns: number;
  };
}

type TaskStatus = "pending" | "running" | "completed" | "failed" | "skipped";

interface TaskStatusInfo {
  taskId: number;
  status: TaskStatus;
  startTime?: number;
  endTime?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
  };
}

interface OrchestratorDetails {
  tasks: TaskDefinition[];
  results: TaskResult[];
  taskStatuses: TaskStatusInfo[];
  executionPlan: ExecutionGroup[];
  currentGroup: number;
  status: "running" | "completed" | "error";
}

interface ExecutionGroup {
  groupIndex: number;
  taskIds: number[];
  type: "unique" | "parallel";
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

function formatUsageStats(usage: TaskResult["usage"]): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

function getPiInvocation(): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args: [] };
  }
  return { command: "pi", args: [] };
}

function getStatusIcon(status: TaskStatus, theme: any): string {
  switch (status) {
    case "running":
      return theme.fg("warning", "●");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "skipped":
      return theme.fg("dim", "○");
    case "pending":
    default:
      return theme.fg("muted", "○");
  }
}

// ── Execution Plan Builder ─────────────────────────────────────────────────────

function buildExecutionPlan(tasks: TaskDefinition[]): ExecutionGroup[] {
  const completed = new Set<number>();
  const groups: ExecutionGroup[] = [];
  let groupIndex = 0;

  while (completed.size < tasks.length) {
    const ready = tasks.filter(
      (t) => !completed.has(t.id) && t.context.every((dep) => completed.has(dep))
    );

    if (ready.length === 0) {
      throw new Error(
        `Circular dependency detected. Remaining: ${tasks
          .filter((t) => !completed.has(t.id))
          .map((t) => t.id)
          .join(", ")}`
      );
    }

    const parallelTasks = ready.filter((t) => t.type === "parallel");
    const uniqueTasks = ready.filter((t) => t.type === "unique");

    if (parallelTasks.length > 0) {
      groups.push({
        groupIndex: groupIndex++,
        taskIds: parallelTasks.map((t) => t.id),
        type: "parallel",
      });
    }

    for (const task of uniqueTasks) {
      groups.push({
        groupIndex: groupIndex++,
        taskIds: [task.id],
        type: "unique",
      });
    }

    for (const task of ready) {
      completed.add(task.id);
    }
  }

  return groups;
}

// ── Subagent Runner ────────────────────────────────────────────────────────────

type OnTaskUpdate = (taskId: number, status: TaskStatus, partialResult?: Partial<TaskResult>) => void;

async function runSubagent(
  task: TaskDefinition,
  contextOutputs: Map<number, string>,
  cwd: string,
  onTaskUpdate: OnTaskUpdate,
  signal?: AbortSignal
): Promise<TaskResult> {
  const result: TaskResult = {
    task,
    output: "",
    exitCode: 0,
    startTime: Date.now(),
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
  };

  onTaskUpdate(task.id, "running", { startTime: result.startTime });

  // Build system prompt with context from dependencies
  let systemContext = "";
  if (task.context.length > 0) {
    systemContext = "\n\n## Context from Previous Tasks\n\n";
    for (const depId of task.context) {
      const depOutput = contextOutputs.get(depId);
      if (depOutput) {
        systemContext += `### Task ${depId} Output\n\n${depOutput}\n\n`;
      }
    }
  }

  const fullPrompt = `${task.description}${systemContext}`;

  // Create temp files
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const promptPath = path.join(tmpDir, `prompt-task-${task.id}.md`);
  await fs.promises.writeFile(promptPath, fullPrompt, { encoding: "utf-8", mode: 0o600 });

  const systemPromptPath = path.join(tmpDir, `system-task-${task.id}.md`);
  const systemPrompt = `You are a subagent executing task: "${task.title}"

Your task is to complete the following work and return your final output. You have access to standard tools (read, write, edit, bash, grep, find, ls) but NOT the subagents tool.

When you are done, provide your complete output as your final response.`;
  await fs.promises.writeFile(systemPromptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

  const piArgs = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--append-system-prompt", systemPromptPath,
    "--tools", "read,write,edit,bash,grep,find,ls",
  ];

  if (selectedSubagentModel) {
    piArgs.push("--model", selectedSubagentModel);
  }

  if (selectedSubagentThinking && selectedSubagentThinking !== "off") {
    piArgs.push("--thinking", selectedSubagentThinking);
  }

  piArgs.push(`@${promptPath}`);

  return new Promise<TaskResult>((resolve) => {
    const invocation = getPiInvocation();
    const proc = spawn(invocation.command, [...invocation.args, ...piArgs], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    let wasAborted = false;

    proc.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            if (msg.role === "assistant") {
              for (const part of msg.content) {
                if (part.type === "text") {
                  result.output = part.text;
                }
              }
              if (msg.usage) {
                result.usage!.input += msg.usage.input || 0;
                result.usage!.output += msg.usage.output || 0;
                result.usage!.cacheRead += msg.usage.cacheRead || 0;
                result.usage!.cost += msg.usage.cost?.total || 0;
                result.usage!.turns = (result.usage!.turns || 0) + 1;
              }
              // Emit partial update with latest output
              onTaskUpdate(task.id, "running", { ...result });
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    proc.stderr.on("data", (data) => {
      result.error = (result.error || "") + data.toString();
    });

    proc.on("close", (code) => {
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          if (event.type === "message_end" && event.message) {
            const msg = event.message as Message;
            if (msg.role === "assistant") {
              for (const part of msg.content) {
                if (part.type === "text") {
                  result.output = part.text;
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
      result.exitCode = code ?? 0;
      result.endTime = Date.now();

      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

      if (wasAborted) {
        result.error = "Task was aborted";
        result.exitCode = 1;
        onTaskUpdate(task.id, "failed", result);
      } else {
        onTaskUpdate(task.id, result.exitCode === 0 ? "completed" : "failed", result);
      }
      resolve(result);
    });

    proc.on("error", (err) => {
      result.error = err.message;
      result.exitCode = 1;
      result.endTime = Date.now();
      fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      onTaskUpdate(task.id, "failed", result);
      resolve(result);
    });

    if (signal) {
      const killProc = () => {
        wasAborted = true;
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });
}

// ── Extension ──────────────────────────────────────────────────────────────────

// State for selected model and thinking level
let selectedSubagentModel: string | null = null;
let selectedSubagentThinking: string = "medium";

const SubagentsParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      id: Type.Number({ description: "Unique task identifier" }),
      context: Type.Array(Type.Number(), {
        description: "IDs of dependency tasks whose output should be available",
      }),
      type: Type.Union([Type.Literal("unique"), Type.Literal("parallel")], {
        description: "'unique' runs alone, 'parallel' runs with other parallel tasks in same group",
      }),
      title: Type.String({ description: "Short title for the task" }),
      description: Type.String({ description: "Detailed description of what the task should accomplish" }),
    }),
    { description: "Array of tasks to execute in dependency order" }
  ),
});

export default function (pi: ExtensionAPI) {
  // ── Register /subagents-model command ───────────────────────────────────────
  pi.registerCommand("subagents-model", {
    description: "Choose model for subagent processes",
    handler: async (_args, ctx) => {
      const allModels = await ctx.modelRegistry.getAvailable();
      if (allModels.length === 0) {
        ctx.ui.notify("No models available", "error");
        return;
      }

      // Format models like pi's model list
      const formatContextWindow = (cw: number): string => {
        if (cw >= 1000000) return `${(cw / 1000000).toFixed(0)}M`;
        if (cw >= 1000) return `${Math.round(cw / 1000)}K`;
        return `${cw}`;
      };

      // Build select items
      const items: SelectItem[] = allModels.map((m) => {
        const ctx = formatContextWindow(m.contextWindow);
        const reasoning = m.reasoning ? "yes" : "no";
        const images = m.input?.includes("image") ? "yes" : "no";
        return {
          value: `${m.provider}/${m.id}`,
          label: `${m.name || m.id}`,
          description: `${m.provider}/${m.id} • ${ctx}, reasoning:${reasoning}, images:${images}`,
        };
      });

      // Add default option at the top
      items.unshift({
        value: "__default__",
        label: "Use default (current model)",
        description: "Subagents will use the same model as the parent",
      });

      const choice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();

        // Top border
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        // Title
        container.addChild(new Text(theme.fg("accent", theme.bold("Select model for subagents:")), 1, 0));

        // SelectList with max 7 visible items
        const selectList = new SelectList(items, Math.min(items.length, 7), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        // Help text
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));

        // Bottom border
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        // Return component with handleInput
        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
        };
      });

      if (choice === undefined || choice === "__default__") {
        selectedSubagentModel = null;
        ctx.ui.notify("Subagents will use the default model", "info");
      } else if (choice) {
        selectedSubagentModel = choice;
        
        // Now show thinking level selector
        // Find the selected model to get supported thinking levels
        const selectedModel = allModels.find((m) => `${m.provider}/${m.id}` === choice);
        const supportedLevels = selectedModel 
          ? getSupportedThinkingLevels(selectedModel)
          : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

        const allThinkingLevels: Record<string, string> = {
          "off": "No reasoning",
          "minimal": "Minimal reasoning",
          "low": "Low reasoning",
          "medium": "Medium reasoning",
          "high": "High reasoning",
          "xhigh": "Extra high reasoning",
          "max": "Maximum reasoning",
        };

        // Filter to only supported levels
        const thinkingLevels = supportedLevels.map((level) => ({
          value: level,
          label: level,
          description: allThinkingLevels[level] || level,
        }));

        const thinkingChoice = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
          const container = new Container();

          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
          container.addChild(new Text(theme.fg("accent", theme.bold("Select thinking level:")), 1, 0));

          const selectList = new SelectList(thinkingLevels, thinkingLevels.length, {
            selectedPrefix: (t) => theme.fg("accent", t),
            selectedText: (t) => theme.fg("accent", t),
            description: (t) => theme.fg("muted", t),
            scrollInfo: (t) => theme.fg("dim", t),
            noMatch: (t) => theme.fg("warning", t),
          });
          // Preselect current thinking level (or first available if not supported)
          let currentIdx = thinkingLevels.findIndex((l) => l.value === selectedSubagentThinking);
          if (currentIdx < 0 && thinkingLevels.length > 0) {
            // Current level not supported, try to find a reasonable default
            currentIdx = thinkingLevels.findIndex((l) => l.value === "medium");
            if (currentIdx < 0) currentIdx = 0;
          }
          if (currentIdx >= 0) selectList.setSelectedIndex(currentIdx);
          selectList.onSelect = (item) => done(item.value);
          selectList.onCancel = () => done(null);
          container.addChild(selectList);

          container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
          container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

          return {
            render: (w) => container.render(w),
            invalidate: () => container.invalidate(),
            handleInput: (data) => { selectList.handleInput(data); tui.requestRender(); },
          };
        });

        if (thinkingChoice) {
          selectedSubagentThinking = thinkingChoice;
          ctx.ui.notify(`Subagent model: ${choice} | Thinking: ${thinkingChoice}`, "info");
        } else {
          ctx.ui.notify(`Subagent model set to: ${choice}`, "info");
        }
      }
    },
  });

  // ── Register /subagents command ────────────────────────────────────────────
  pi.registerCommand("subagents", {
    description: "Format a prompt for subagent task decomposition",
    handler: async (args, ctx) => {
      const userPrompt = args || ctx.getSystemPrompt();
      const formattedPrompt = `how can we can answer to this:
 - *${userPrompt}*
   reply with **tasks**,and the needed **context**, in this estructure for the tool **subagents**:

\`\`\`json
{
"tasks":
  [
    {
      "id":0,
      "context":[0,1,2], #(task context dependencies)
      "type":"unique or parallel", #(parallel tasks most be in sequence)
      "title":"",
      "description":""
    }
  ]
}
\`\`\`

Use the **subagents** tool to execute the tasks once you have the JSON structure.`;

      ctx.ui.notify("Prompt formatted. Send it to the agent to generate task JSON.", "info");
      pi.sendUserMessage(formattedPrompt, { deliverAs: "followUp" });
    },
  });

  // ── Register subagents tool ────────────────────────────────────────────────
  pi.registerTool({
    name: "subagents",
    label: "Subagents",
    description:
      "Execute a DAG of tasks as isolated pi processes. Each task runs with its own context window. " +
      "Tasks execute in dependency order: parallel tasks run simultaneously, unique tasks run alone. " +
      "Context from dependency tasks is automatically included in each task's system prompt.",
    promptSnippet: "Execute multiple tasks as isolated subagent processes in dependency order",
    promptGuidelines: [
      "Use subagents when you need to decompose a complex task into independent or dependent subtasks that benefit from isolated context windows.",
    ],
    parameters: SubagentsParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const tasks = params.tasks;

      if (tasks.length === 0) {
        return {
          content: [{ type: "text", text: "No tasks provided." }],
          details: {
            tasks: [],
            results: [],
            taskStatuses: [],
            executionPlan: [],
            currentGroup: 0,
            status: "completed",
          } as OrchestratorDetails,
        };
      }

      // Validate dependencies
      const taskIds = new Set(tasks.map((t) => t.id));
      for (const task of tasks) {
        for (const dep of task.context) {
          if (!taskIds.has(dep)) {
            return {
              content: [{ type: "text", text: `Task ${task.id} depends on non-existent task ${dep}.` }],
              details: {
                tasks,
                results: [],
                taskStatuses: [],
                executionPlan: [],
                currentGroup: 0,
                status: "error",
              } as OrchestratorDetails,
              isError: true,
            };
          }
        }
      }

      // Build execution plan
      let executionPlan: ExecutionGroup[];
      try {
        executionPlan = buildExecutionPlan(tasks);
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to build execution plan: ${err}` }],
          details: {
            tasks,
            results: [],
            taskStatuses: [],
            executionPlan: [],
            currentGroup: 0,
            status: "error",
          } as OrchestratorDetails,
          isError: true,
        };
      }

      const taskMap = new Map(tasks.map((t) => [t.id, t]));
      const results: TaskResult[] = [];
      const contextOutputs = new Map<number, string>();

      // Initialize task statuses
      const taskStatuses: TaskStatusInfo[] = tasks.map((t) => ({
        taskId: t.id,
        status: "pending" as TaskStatus,
      }));
      const statusMap = new Map(taskStatuses.map((s) => [s.taskId, s]));

      const makeDetails = (
        status: OrchestratorDetails["status"],
        currentGroup: number
      ): OrchestratorDetails => ({
        tasks,
        results,
        taskStatuses: [...taskStatuses],
        executionPlan,
        currentGroup,
        status,
      });

      // Task update callback
      const onTaskUpdate: OnTaskUpdate = (taskId, status, partialResult) => {
        const statusInfo = statusMap.get(taskId);
        if (statusInfo) {
          statusInfo.status = status;
          if (status === "running" && !statusInfo.startTime) {
            statusInfo.startTime = Date.now();
          }
          if (status === "completed" || status === "failed") {
            statusInfo.endTime = Date.now();
          }
          // Track usage from partial result
          if (partialResult?.usage) {
            statusInfo.usage = {
              input: partialResult.usage.input || 0,
              output: partialResult.usage.output || 0,
              cacheRead: partialResult.usage.cacheRead || 0,
            };
          }
        }

        // Update partial result if provided
        if (partialResult) {
          const existing = results.find((r) => r.task.id === taskId);
          if (existing) {
            Object.assign(existing, partialResult);
          }
        }

        // Emit real-time update
        const runningCount = taskStatuses.filter((s) => s.status === "running").length;
        const doneCount = taskStatuses.filter((s) => s.status === "completed" || s.status === "failed").length;
        const currentGroup = executionPlan.findIndex((g) =>
          g.taskIds.some((id) => statusMap.get(id)?.status === "running")
        );

        onUpdate?.({
          content: [
            {
              type: "text",
              text: `${doneCount}/${tasks.length} done, ${runningCount} running...`,
            },
          ],
          details: makeDetails("running", currentGroup >= 0 ? currentGroup : 0),
        });
      };

      // Periodic update timer (every 5 seconds for running tasks)
      const updateInterval = setInterval(() => {
        const runningCount = taskStatuses.filter((s) => s.status === "running").length;
        if (runningCount === 0) {
          clearInterval(updateInterval);
          return;
        }
        const currentGroup = executionPlan.findIndex((g) =>
          g.taskIds.some((id) => statusMap.get(id)?.status === "running")
        );
        onUpdate?.({
          content: [{ type: "text", text: `Running...` }],
          details: makeDetails("running", currentGroup >= 0 ? currentGroup : 0),
        });
      }, 5000);

      // Stream initial state
      onUpdate?.({
        content: [{ type: "text", text: `Starting ${tasks.length} tasks in ${executionPlan.length} groups...` }],
        details: makeDetails("running", 0),
      });

      // Execute groups sequentially
      for (let groupIdx = 0; groupIdx < executionPlan.length; groupIdx++) {
        const group = executionPlan[groupIdx];

        if (signal?.aborted) {
          for (const id of group.taskIds) {
            const task = taskMap.get(id)!;
            results.push({
              task,
              output: "",
              error: "Orchestrator was aborted",
              exitCode: 1,
            });
            onTaskUpdate(id, "skipped");
          }
          break;
        }

        const groupTasks = group.taskIds.map((id) => taskMap.get(id)!);

        if (group.type === "parallel" && groupTasks.length > 1) {
          // Run parallel tasks concurrently with individual updates
          const groupResults = await Promise.all(
            groupTasks.map((task) =>
              runSubagent(task, contextOutputs, ctx.cwd, onTaskUpdate, signal)
            )
          );
          for (const result of groupResults) {
            results.push(result);
            contextOutputs.set(result.task.id, result.output);
          }
        } else {
          // Run unique tasks sequentially
          for (const task of groupTasks) {
            const result = await runSubagent(task, contextOutputs, ctx.cwd, onTaskUpdate, signal);
            results.push(result);
            contextOutputs.set(task.id, result.output);
          }
        }
      }

      // Stop periodic updates
      clearInterval(updateInterval);

      // Build final summary
      const successCount = results.filter((r) => r.exitCode === 0).length;
      const failCount = results.filter((r) => r.exitCode !== 0).length;

      let summary = `Subagents completed: ${successCount}/${tasks.length} succeeded`;
      if (failCount > 0) summary += `, ${failCount} failed`;

      const resultTexts = results.map((r) => {
        const icon = r.exitCode === 0 ? "✓" : "✗";
        const duration = r.startTime && r.endTime ? ` (${formatDuration(r.endTime - r.startTime)})` : "";
        const usage = formatUsageStats(r.usage);
        return `\n${icon} Task ${r.task.id}: ${r.task.title}${duration}\n${r.output || r.error || "(no output)"}${usage ? `\n${usage}` : ""}`;
      });

      return {
        content: [{ type: "text", text: summary + resultTexts.join("\n") }],
        details: makeDetails("completed", executionPlan.length),
      };
    },

    // ── Custom Rendering ──────────────────────────────────────────────────────
    renderCall(args, theme, context) {
      const taskCount = args.tasks?.length ?? 0;
      const groups = args.tasks ? buildExecutionPlan(args.tasks) : [];
      const groupCount = groups.length;

      let text =
        theme.fg("toolTitle", theme.bold("subagents ")) +
        theme.fg("accent", `${taskCount} tasks`) +
        theme.fg("muted", ` in ${groupCount} groups`);

      const previewTasks = args.tasks?.slice(0, 3) ?? [];
      for (const task of previewTasks) {
        const preview = task.title.length > 40 ? `${task.title.slice(0, 40)}...` : task.title;
        text += `\n  ${theme.fg("muted", `${task.id}.`)} ${theme.fg("accent", preview)}`;
      }
      if (taskCount > 3) {
        text += `\n  ${theme.fg("muted", `... +${taskCount - 3} more`)}`;
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as OrchestratorDetails | undefined;
      if (!details || details.tasks.length === 0) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }

      const mdTheme = getMarkdownTheme();
      const { tasks, results, taskStatuses, executionPlan, currentGroup, status } = details;

      // Overall status icon
      const statusIcon =
        status === "running"
          ? theme.fg("warning", "⏳")
          : status === "error"
            ? theme.fg("error", "✗")
            : theme.fg("success", "✓");

      const doneCount = taskStatuses.filter(
        (s) => s.status === "completed" || s.status === "failed"
      ).length;
      const runningCount = taskStatuses.filter((s) => s.status === "running").length;

      if (expanded) {
        const container = new Container();

        // Header with progress
        container.addChild(
          new Text(
            `${statusIcon} ${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg(
              "accent",
              `${doneCount}/${tasks.length} done`
            )}${runningCount > 0 ? theme.fg("warning", ` (${runningCount} running)`) : ""}`,
            0,
            0
          )
        );

        // Task status list (real-time view)
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Tasks ───"), 0, 0));

        for (const ts of taskStatuses) {
          const task = tasks.find((t) => t.id === ts.taskId)!;
          const icon = getStatusIcon(ts.status, theme);
          const result = results.find((r) => r.task.id === ts.taskId);

          let line = `${icon} ${theme.fg("accent", `${task.id}: ${task.title}`)}`;

          // Show duration for completed/running tasks
          if (ts.status === "running" && ts.startTime) {
            const elapsed = Date.now() - ts.startTime;
            line += theme.fg("warning", ` (${formatDuration(elapsed)})`);
            // Show token usage if available
            if (ts.usage && (ts.usage.input > 0 || ts.usage.output > 0)) {
              line += theme.fg("dim", ` ↑${formatTokens(ts.usage.input)} ↓${formatTokens(ts.usage.output)} R${formatTokens(ts.usage.cacheRead)}`);
            }
          } else if ((ts.status === "completed" || ts.status === "failed") && ts.startTime && ts.endTime) {
            line += theme.fg("dim", ` (${formatDuration(ts.endTime - ts.startTime)})`);
            // Show final token usage
            if (ts.usage && (ts.usage.input > 0 || ts.usage.output > 0)) {
              line += theme.fg("dim", ` ↑${formatTokens(ts.usage.input)} ↓${formatTokens(ts.usage.output)} R${formatTokens(ts.usage.cacheRead)}`);
            }
          }

          // Show partial output for running tasks
          if (ts.status === "running" && result?.output) {
            const preview = result.output.split("\n").slice(0, 2).join(" ").slice(0, 50);
            line += `\n    ${theme.fg("dim", preview)}...`;
          }

          container.addChild(new Text(line, 0, 0));
        }

        // Execution plan
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", "─── Execution Plan ───"), 0, 0));
        for (let i = 0; i < executionPlan.length; i++) {
          const group = executionPlan[i];
          const groupTasks = group.taskIds.map((id) => tasks.find((t) => t.id === id)!);
          const typeLabel = group.type === "parallel" ? "parallel" : "sequential";
          const isCurrentGroup = i === currentGroup && status === "running";
          const taskLabels = groupTasks.map((t) => theme.fg("accent", `${t.id}:${t.title}`)).join(", ");

          const prefix = isCurrentGroup ? theme.fg("warning", "▶ ") : "  ";
          container.addChild(
            new Text(
              `${prefix}${theme.fg("muted", `G${group.groupIndex + 1}`)} [${theme.fg("warning", typeLabel)}] ${taskLabels}`,
              0,
              0
            )
          );
        }

        // Final outputs (only when completed)
        if (status === "completed" || status === "error") {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Outputs ───"), 0, 0));

          for (const r of results) {
            const icon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            container.addChild(new Spacer(1));
            container.addChild(
              new Text(
                `${icon} ${theme.fg("accent", `Task ${r.task.id}: ${r.task.title}`)}`,
                0,
                0
              )
            );

            if (r.output) {
              container.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
            } else if (r.error) {
              container.addChild(new Text(theme.fg("error", `Error: ${r.error}`), 0, 0));
            } else {
              container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
            }

            const usage = formatUsageStats(r.usage);
            if (usage) {
              container.addChild(new Text(theme.fg("dim", usage), 0, 0));
            }
          }
        }

        return container;
      }

      // ── Collapsed view (real-time) ──────────────────────────────────────────
      let text = `${statusIcon} ${theme.fg("toolTitle", theme.bold("subagents "))}${theme.fg(
        "accent",
        `${doneCount}/${tasks.length}`
      )}${runningCount > 0 ? theme.fg("warning", ` ●${runningCount}`) : ""}`;

      // Show each task with status
      for (const ts of taskStatuses) {
        const task = tasks.find((t) => t.id === ts.taskId)!;
        const icon = getStatusIcon(ts.status, theme);
        const result = results.find((r) => r.task.id === ts.taskId);

        let line = `\n${icon} ${theme.fg("accent", `${task.id}:${task.title}`)}`;

        // Show timing or preview
        if (ts.status === "running" && ts.startTime) {
          const elapsed = Date.now() - ts.startTime;
          line += ` ${theme.fg("warning", formatDuration(elapsed))}`;
          // Show token usage if available
          if (ts.usage && (ts.usage.input > 0 || ts.usage.output > 0)) {
            line += ` ${theme.fg("dim", `↑${formatTokens(ts.usage.input)} ↓${formatTokens(ts.usage.output)} R${formatTokens(ts.usage.cacheRead)}`)}`;
          }
          if (result?.output) {
            const preview = result.output.split("\n")[0]?.slice(0, 40) || "";
            if (preview) line += ` ${theme.fg("dim", preview)}`;
          }
        } else if (ts.status === "completed" && result) {
          // Show duration and token usage
          if (ts.startTime && ts.endTime) {
            line += ` ${theme.fg("dim", formatDuration(ts.endTime - ts.startTime))}`;
          }
          if (ts.usage && (ts.usage.input > 0 || ts.usage.output > 0)) {
            line += ` ${theme.fg("dim", `↑${formatTokens(ts.usage.input)} ↓${formatTokens(ts.usage.output)} R${formatTokens(ts.usage.cacheRead)}`)}`;
          }
          const preview = result.output
            ? result.output.split("\n").slice(0, 2).join(" ").slice(0, 50)
            : "";
          if (preview) line += ` ${theme.fg("dim", preview)}`;
        } else if (ts.status === "failed" && result?.error) {
          line += ` ${theme.fg("error", result.error.slice(0, 40))}`;
        }

        text += line;
      }

      if (status === "running") {
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }

      return new Text(text, 0, 0);
    },
  });
}
