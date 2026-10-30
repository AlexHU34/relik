# Копирует статическое приложение в mobile/www (то, что попадёт в APK).
# Исключения: служебные папки, чтобы APK не разбухал.
$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot      # корень сайта (relik/)
$dst = Join-Path $PSScriptRoot 'www'

if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
New-Item -ItemType Directory -Path $dst | Out-Null

$excludeDirs = @(
  (Join-Path $PSScriptRoot 'node_modules'),
  (Join-Path $PSScriptRoot 'android'),
  (Join-Path $src '.git'),
  (Join-Path $src 'mobile'),
  (Join-Path $src 'scripts'),
  (Join-Path $src 'supabase'),
  (Join-Path $src 'tools')
)
$excludeFiles = @('.gitignore')

robocopy $src $dst /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }

Write-Host "Готово: $dst" -ForegroundColor Green
Write-Host 'Дальше: npm install; npm run add:android (один раз); npm run open'
