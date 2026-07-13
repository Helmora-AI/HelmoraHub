# Windows install helper (VPS / local). Requires Node 20+.
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

$major = [int]((node -p "process.versions.node.split('.')[0]"))
if ($major -lt 20) {
  throw "Helmora Hub requires Node.js 20+. Found: $(node -v)"
}

if (Test-Path package-lock.json) {
  npm ci
} else {
  npm install
}

npm run build
New-Item -ItemType Directory -Force -Path data | Out-Null

if (-not (Test-Path .env) -and (Test-Path .env.example)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example"
}

Write-Host "Done. Start: npm start   Dev: npm run dev"
Write-Host "Settings: http://127.0.0.1:20800/settings"
