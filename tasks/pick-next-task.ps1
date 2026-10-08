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
# Within the same priority bucket, tasks are sorted alphabetically.
# Files prefixed "proto-" are always ignored.
# Tasks whose "depends on:" dependencies are not yet in tasks/done/ are skipped.
#
# Outputs the bare filename (e.g. "refactor-foo.md") to stdout.
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

# ── Dependency resolution ────────────────────────────────────────────────────

function Get-Dependencies([string]$filePath) {
    # Read only the first 15 lines — dependencies must appear near the top.
    $lines = Get-Content $filePath -TotalCount 15 -ErrorAction SilentlyContinue
    $deps  = [System.Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        # Matches lines like:
        #   depends on: foo.md
        #   **Depends on:** `foo.md`, `bar.md`
        if ($line -match '(?i)depends\s+on\s*:\s*(.+)') {
            $raw = $Matches[1]
            foreach ($part in ($raw -split '[,;]')) {
                $clean = $part.Trim().Trim('`').Trim('*').Trim()
                if ($clean -ne '') { $deps.Add($clean) }
            }
        }
    }
    return $deps.ToArray()
}

function Test-DependenciesMet([string[]]$deps) {
    foreach ($dep in $deps) {
        # Normalise: strip path and ensure .md extension for the lookup
        $base = [System.IO.Path]::GetFileNameWithoutExtension($dep)
        $done1 = Join-Path $doneDir "$base.md"
        $done2 = Join-Path $doneDir $dep
        if (-not (Test-Path $done1) -and -not (Test-Path $done2)) {
            return $false
        }
    }
    return $true
}

# ── Collect eligible candidates ──────────────────────────────────────────────

$candidates = [System.Collections.Generic.List[PSCustomObject]]::new()

Get-ChildItem -Path $backlogDir -Filter '*.md' |
    Where-Object { $_.Name -notlike 'proto-*' } |
    ForEach-Object {
        $deps = Get-Dependencies $_.FullName
        if (Test-DependenciesMet $deps) {
            $candidates.Add([PSCustomObject]@{
                Name     = $_.Name
                Priority = Get-Priority $_.Name
            })
        }
    }

if ($candidates.Count -eq 0) {
    Write-Error 'pick-next-task: backlog is empty or all remaining tasks have unmet dependencies.'
    exit 1
}

$selected = $candidates |
    Sort-Object Priority, Name |
    Select-Object -First 1

Write-Output $selected.Name
exit 0
