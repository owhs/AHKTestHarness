<#
.SYNOPSIS  Builds the native host (native\*.cs -> bin\ahkh-host.exe) with the .NET Framework 4.x csc.exe (C# 5, no SDK needed).
.PARAMETER Force  Rebuild even if the sources are unchanged.
#>
param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$fw = Join-Path $env:windir 'Microsoft.NET\Framework64\v4.0.30319'
$csc = Join-Path $fw 'csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:windir 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw "csc.exe (.NET Framework 4) not found" }

$src = Get-ChildItem (Join-Path $root 'native') -Filter *.cs | Sort-Object Name
$bin = Join-Path $root 'bin'; New-Item -ItemType Directory -Force $bin | Out-Null
$out = Join-Path $bin 'ahkh-host.exe'
$hashFile = Join-Path $bin '.host.hash'

$sha = [Security.Cryptography.SHA1]::Create()
$ms = New-Object IO.MemoryStream
foreach ($f in $src) { $b = [IO.File]::ReadAllBytes($f.FullName); $ms.Write($b, 0, $b.Length); $n = [Text.Encoding]::UTF8.GetBytes($f.Name); $ms.Write($n, 0, $n.Length) }
$hash = ([BitConverter]::ToString($sha.ComputeHash($ms.ToArray()))).Replace('-', '')
if (-not $Force -and (Test-Path $out) -and (Test-Path $hashFile) -and ((Get-Content $hashFile -Raw).Trim() -eq $hash)) { Write-Host "ahkh-host.exe up to date"; exit 0 }

$wpf = Join-Path $fw 'WPF'
$refs = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll',
          (Join-Path $wpf 'UIAutomationClient.dll'), (Join-Path $wpf 'UIAutomationTypes.dll'), (Join-Path $wpf 'WindowsBase.dll'))
$rsp = Join-Path $bin 'host.rsp'
$lines = @('/nologo', '/optimize+', '/debug-', '/target:winexe', '/platform:anycpu', '/warn:4', "/out:`"$out`"") +
         ($refs | ForEach-Object { "/r:`"$_`"" }) + ($src | ForEach-Object { "`"$($_.FullName)`"" })
Set-Content -Path $rsp -Value $lines -Encoding ASCII
& $csc "@$rsp"
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
Set-Content $hashFile $hash
Write-Host "built $out"
