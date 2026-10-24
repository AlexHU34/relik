# Relik — локальный сервер для разработки
param([int]$Port = 8080)

$root = Split-Path -Parent $PSScriptRoot
Write-Host "Relik dev server → http://localhost:$Port" -ForegroundColor Cyan
Start-Process "http://localhost:$Port"

python -m http.server $Port --directory $root
