# Subagents Orchestrator

A pi extension that decomposes complex tasks into isolated subagent processes with dependency-aware execution.

## Features

- **`/subagents` command**: Formats a prompt for the LLM to produce a task JSON structure
- **`/subagents-model` command**: Choose which model subagents will use
- **`subagents` tool**: Executes tasks as isolated pi processes in dependency order
- **Visual output**: Collapsed/expanded views with execution plan and per-task results

## Usage

### Optional: Choose model for subagents

```
/subagents-model
```

This opens a menu to select which model subagents will use. By default, subagents use the same model as the parent process.

### Step 1: Use the /subagents command

Type in chat:
```
/subagents Your complex task description here
```

This will format a prompt asking the LLM to decompose your task into a JSON structure.

### Step 2: LLM generates task JSON

The LLM will produce a JSON like:
```json
{
  "tasks": [
    {
      "id": 0,
      "context": [],
      "type": "unique",
      "title": "Research",
      "description": "Research the codebase structure..."
    },
    {
      "id": 1,
      "context": [0],
      "type": "parallel",
      "title": "Implement Feature A",
      "description": "Implement feature A using the research..."
    },
    {
      "id": 2,
      "context": [0],
      "type": "parallel",
      "title": "Implement Feature B",
      "description": "Implement feature B using the research..."
    },
    {
      "id": 3,
      "context": [1, 2],
      "type": "unique",
      "title": "Integration",
      "description": "Integrate features A and B..."
    }
  ]
}
```

### Step 3: Execute with subagents tool

The LLM will call the `subagents` tool with the JSON, and tasks will execute in order:
- Task 0 (Research) runs first
- Tasks 1 and 2 (Features A & B) run in parallel
- Task 3 (Integration) runs last after both complete

## Task Types

- **`unique`**: Runs alone in its own group
- **`parallel`**: Runs simultaneously with other parallel tasks that share the same dependency context

## Execution Order

Tasks execute based on their dependency graph:
1. Tasks with no dependencies run first
2. Once those complete, tasks whose dependencies are satisfied run next
3. Parallel tasks in the same group execute concurrently
4. Unique tasks each get their own execution group

## Context Injection

Each subagent receives context from its dependency tasks in its system prompt. This allows tasks to build on previous results.

## Visual Output

- **Collapsed**: Shows task count, groups, and brief status for each task
- **Expanded**: Shows full execution plan, per-task output as markdown, and usage statistics

Toggle with `Ctrl+O`.

## Example

User: `/subagents Create a REST API with auth, users, and posts endpoints`

LLM produces:
```json
{
  "tasks": [
    {
      "id": 0,
      "context": [],
      "type": "unique",
      "title": "Project Setup",
      "description": "Set up Node.js project with Express, TypeScript, and database config"
    },
    {
      "id": 1,
      "context": [0],
      "type": "unique",
      "title": "Auth System",
      "description": "Implement JWT authentication with login/register endpoints"
    },
    {
      "id": 2,
      "context": [0],
      "type": "parallel",
      "title": "Users API",
      "description": "Implement CRUD endpoints for users"
    },
    {
      "id": 3,
      "context": [0],
      "type": "parallel",
      "title": "Posts API",
      "description": "Implement CRUD endpoints for posts"
    },
    {
      "id": 4,
      "context": [1, 2, 3],
      "type": "unique",
      "title": "Integration Tests",
      "description": "Write integration tests for all endpoints"
    }
  ]
}
```

Execution order:
1. Task 0: Project Setup
2. Task 1: Auth System
3. Tasks 2 & 3: Users API + Posts API (parallel)
4. Task 4: Integration Tests
