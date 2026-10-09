# Runs blackwall in dev mode with hot reload: Vite serves the web app (HMR) and the server
# restarts on source changes (tsx watch). Opens the app in the browser once Vite is up.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Test-Path node_modules)) { pnpm install }

$webPort = if ($env:BLACKWALL_WEB_PORT) { $env:BLACKWALL_WEB_PORT } else { 5173 }
$url = "http://127.0.0.1:$webPort"

# Open the browser once Vite answers; the dev server is started with --no-open.
Start-Job -ArgumentList $url {
    param($url)
    for ($i = 0; $i -lt 60; $i++) {
        try { Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 1 | Out-Null; Start-Process $url; return }
        catch { Start-Sleep -Milliseconds 500 }
    }
} | Out-Null

pnpm dev
