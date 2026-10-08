---
name: create-task
description: 'Create a new task file in /tasks/backlog/. Use when the user wants to plan, define, or capture a new piece of work.'
argument-hint: 'Description of the task to create (e.g. "add user notifications")'
---

Follow the `caveman` skill for narration and status updates while running this — terse, no filler. The task file content itself stays normal prose (caveman's own boundaries).

Create a markdown file in /tasks/backlog with a hyphenated, simplified name of as the file name, for example "create-users.md". The file should contain a detailed description of the task, including the motivation, the specific code areas that need to be changed, and any relevant code snippets. 

Include a list of specific changes to be made, if possible or available from an analysis document. If the task becomes too complex or large, split it into multiple tasks, using a dependency between them given by "depends-on: file-name.md"  at the top of the file.