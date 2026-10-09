# pick-next-task.ps1
#
# Deterministically selects the next eligible task from tasks/backlog/.
#
# Priority order (lower number = higher priority):
#   0  simple-*
#   1  standalone-*
#   2  bugfix-*
#   3  perf-*
#   4  sec-*
#   5  everything else
#
# Within the same priority bucket, tasks are sorted by task number, then by
# name. The number is the filename's leading digits ("0031-backlog-ui.md") or,
# for older files, the digits after "task-" ("task-027-foo.md"). Files without
# a number sort after numbered ones, alphabetically.
# Files prefixed "proto-" are always ignored.
#
# Dependencies are read from the top of each file. Supported forms:
#   depends_on: [task-003, task-004]      (YAML frontmatter, inline list)
#   depends_on:                           (YAML frontmatter, block list)
#     - task-003
#   **Depends on:** `foo.md`, `bar.md`    (markdown)
# A dependency matches a task by its frontmatter "id:" or by its filename
# (with or without .md).
#
# Selection walks the backlog in priority order. When the next task has
# unmet dependencies, the picker descends into those dependencies (in the
# order listed) and returns the first one that is ready, so dependencies get
# done before the tasks that need them, even if they sort later. A task whose
# dependency exists neither in backlog/ nor done/ is blocked.
#
# Outputs the bare filename (e.g. "0031-backlog-ui.md") to stdout.
# Exits 0 on success, 1 if no eligible task exists.

param(
    [string]$Root = $PSScriptRoot
)

$backlogDir = Join-Path $Root 'backlog'
$doneDir    = Join-Path $Root 'done'

# ── Priority bucket ──────────────────────────────────────────────────────────

function Get-Priority([string]$name) {
    if ($name -like 'simple-*')     { return 0 }
    if ($name -like 'standalone-*') { return 1 }
    if ($name -like 'bugfix-*')     { return 2 }
    if ($name -like 'perf-*')       { return 3 }
    if ($name -like 'sec-*')        { return 4 }
    return 5
}

function Get-TaskNumber([string]$name) {
    if ($name -match '^(?:task-)?(\d+)') { return [int]$Matches[1] }
    return [int]::MaxValue
}

# ── Parsing ──────────────────────────────────────────────────────────────────

function ConvertTo-DepName([string]$raw) {
    $clean = $raw.Trim().Trim('[', ']', '`', '*', '"', "'", ' ')
    if ($clean -like '*.md') { $clean = [System.IO.Path]::GetFileNameWithoutExtension($clean) }
    return $clean
}

function Get-TaskInfo([System.IO.FileInfo]$file) {
    # Read only the first 20 lines — id and dependencies must appear near the top.
    $lines = @(Get-Content $file.FullName -TotalCount 20 -ErrorAction SilentlyContinue)
    $id    = $null
    $deps  = [System.Collections.Generic.List[string]]::new()
    $inBlockList = $false

    foreach ($line in $lines) {
        if ($inBlockList) {
            if ($line -match '^\s*-\s*(.+)$') {
                $dep = ConvertTo-DepName $Matches[1]
                if ($dep -ne '') { $deps.Add($dep) }
                continue
            }
            $inBlockList = $false
        }

        if (-not $id -and $line -match '^\s*id\s*:\s*(\S+)') {
            $id = $Matches[1].Trim('"', "'")
            continue
        }

        if ($line -match '(?i)depends[\s_]*on\s*\**\s*:\s*\**\s*(.*)$') {
            $raw = $Matches[1].Trim()
            if ($raw -eq '') { $inBlockList = $true; continue }
            foreach ($part in ($raw -split '[,;]')) {
                $dep = ConvertTo-DepName $part
                if ($dep -ne '') { $deps.Add($dep) }
            }
        }
    }

    return [PSCustomObject]@{
        Name     = $file.Name
        Base     = $file.BaseName
        Id       = $id
        Deps     = $deps.ToArray()
        Priority = Get-Priority $file.Name
        Number   = Get-TaskNumber $file.Name
    }
}

# ── Index tasks ──────────────────────────────────────────────────────────────

$doneKeys = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
if (Test-Path $doneDir) {
    Get-ChildItem -Path $doneDir -Filter '*.md' | ForEach-Object {
        $info = Get-TaskInfo $_
        [void]$doneKeys.Add($info.Base)
        if ($info.Id) { [void]$doneKeys.Add($info.Id) }
    }
}

$backlog    = @(Get-ChildItem -Path $backlogDir -Filter '*.md' |
    Where-Object { $_.Name -notlike 'proto-*' } |
    ForEach-Object { Get-TaskInfo $_ } |
    Sort-Object Priority, Number, Name)

$backlogByKey = @{}
foreach ($task in $backlog) {
    $backlogByKey[$task.Base.ToLowerInvariant()] = $task
    if ($task.Id) { $backlogByKey[$task.Id.ToLowerInvariant()] = $task }
}

# ── Resolution ───────────────────────────────────────────────────────────────

# Returns the first ready task reachable from $task (itself, or one of its
# unmet dependencies, depth first), or $null if everything on the path is blocked.
function Resolve-Ready($task, [System.Collections.Generic.HashSet[string]]$visiting) {
    if (-not $visiting.Add($task.Name)) { return $null }  # dependency cycle

    $unmet = @($task.Deps | Where-Object { -not $doneKeys.Contains($_) })
    if ($unmet.Count -eq 0) { return $task }

    foreach ($dep in $unmet) {
        $depTask = $backlogByKey[$dep.ToLowerInvariant()]
        if (-not $depTask) { return $null }  # dependency missing entirely: blocked
        $ready = Resolve-Ready $depTask $visiting
        if ($ready) { return $ready }
    }
    return $null
}

foreach ($task in $backlog) {
    $visiting = [System.Collections.Generic.HashSet[string]]::new()
    $ready = Resolve-Ready $task $visiting
    if ($ready) {
        Write-Output $ready.Name
        exit 0
    }
}

Write-Error 'pick-next-task: backlog is empty or all remaining tasks have unmet dependencies.'
exit 1
