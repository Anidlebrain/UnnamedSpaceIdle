@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "ROOT_DIR=%CD%"
set "GALAXY=%~1"
set "NODE=%~2"
set "VERBOSE=0"
set "COPY_RESULT=0"
if /I "%~3"=="--verbose" set "VERBOSE=1"
if /I "%~3"=="--c" set "COPY_RESULT=1"
if /I "%~3"=="--copy" set "COPY_RESULT=1"

if "%GALAXY%"=="" (
  echo ERROR: galaxy argument is required
  echo Usage: run_optimizer.bat g6 B21 [--verbose^|--copy]
  echo Config: "%ROOT_DIR%\map\[galaxy]\[node].json"
  exit /b 1
)
if "%NODE%"=="" (
  echo ERROR: node argument is required
  echo Usage: run_optimizer.bat g6 B21 [--verbose^|--copy]
  echo Config: "%ROOT_DIR%\map\%GALAXY%\[node].json"
  exit /b 1
)
if not "%~4"=="" (
  echo ERROR: unexpected argument: %~4
  echo Usage: run_optimizer.bat g6 B21 [--verbose^|--copy]
  exit /b 1
)
if not "%~3"=="" if /I not "%~3"=="--verbose" if /I not "%~3"=="--c" if /I not "%~3"=="--copy" (
  echo ERROR: unknown option: %~3
  echo Usage: run_optimizer.bat g6 B21 [--verbose^|--copy]
  exit /b 1
)

set "FLEET_GALAXY=%GALAXY%"
set "FLEET_NODE=%NODE%"
powershell.exe -NoProfile -Command "if ($env:FLEET_GALAXY -notmatch '^(?i:g)[0-9]+$') { [Console]::Error.WriteLine('ERROR: galaxy must look like g6: ' + $env:FLEET_GALAXY); exit 2 }; if ($env:FLEET_NODE -notmatch '^[A-Za-z0-9_-]+$') { [Console]::Error.WriteLine('ERROR: node contains unsupported characters: ' + $env:FLEET_NODE); exit 2 }"
if errorlevel 1 exit /b 1

set "GALAXY_ID=galaxy%GALAXY:~1%"
set "GALAXY_DIR=%ROOT_DIR%\map\%GALAXY%"
set "CONFIG_FILE=%GALAXY_DIR%\%NODE%.json"
set "COMMON_FILE=%GALAXY_DIR%\common.json"
set "RESULT_FILE=%GALAXY_DIR%\%NODE%.result.json"
set "SUMMARY_FILE=%GALAXY_DIR%\%NODE%.result.txt"
set "LOG_FILE=%GALAXY_DIR%\%NODE%.godot.log"
set "DAILY_SETTINGS=%ROOT_DIR%\map\optimizer_v2_daily.json"
set "DAILY_SETTINGS_SOURCE=local map"
if not exist "%DAILY_SETTINGS%" (
  set "DAILY_SETTINGS=%ROOT_DIR%\poc\optimizer_v2_daily.json"
  set "DAILY_SETTINGS_SOURCE=poc fallback"
)
set "GODOT_RUNNER=%ROOT_DIR%\tools\run_godot_optimizer.ps1"
set "COPY_RESULT_TOOL=%ROOT_DIR%\tools\copy_result_to_config.ps1"
set "GODOT_PROJECT=%ROOT_DIR%\work\full_recovered"
set "GODOT_DIR=E:\tools\Godot_v4.7.2-stable_win64"
set "GODOT_EXE=%GODOT_DIR%\Godot_v4.7.2-stable_win64_console.exe"
set "RESULTS_DIR=%ROOT_DIR%\results"

if not exist "%GALAXY_DIR%\" (
  echo ERROR: galaxy directory not found
  echo Config: "%CONFIG_FILE%"
  echo Common: "%COMMON_FILE%"
  exit /b 1
)
if not exist "%CONFIG_FILE%" (
  echo ERROR: node JSON not found
  echo Config: "%CONFIG_FILE%"
  exit /b 1
)
if "%COPY_RESULT%"=="0" (
  if not exist "%COMMON_FILE%" (
    echo ERROR: Galaxy common JSON not found
    echo Common: "%COMMON_FILE%"
    echo Config: "%CONFIG_FILE%"
    exit /b 1
  )
  if not exist "%GODOT_EXE%" (
    echo ERROR: Godot executable not found
    echo Expected: "%GODOT_EXE%"
    exit /b 1
  )
  if not exist "%DAILY_SETTINGS%" (
    echo ERROR: internal Optimizer settings not found
    echo Expected: "%DAILY_SETTINGS%"
    exit /b 1
  )
  if not exist "%GODOT_RUNNER%" (
    echo ERROR: internal Godot runner not found
    echo Expected: "%GODOT_RUNNER%"
    exit /b 1
  )
)

set "FLEET_CONFIG_TO_VALIDATE=%CONFIG_FILE%"
powershell.exe -NoProfile -Command "try { $value = Get-Content -LiteralPath $env:FLEET_CONFIG_TO_VALIDATE -Raw | ConvertFrom-Json -ErrorAction Stop; if ($null -eq $value -or $value.GetType().Name -ne 'PSCustomObject') { throw 'top-level JSON value must be an object' }; $expectedGalaxy = [int]$env:FLEET_GALAXY.Substring(1); if ([int]$value.galaxy -ne $expectedGalaxy) { throw ('galaxy field must be ' + $expectedGalaxy) }; $expectedNode = $env:FLEET_NODE -replace '(?i)_num$', ''; if ([string]$value.node -ine $expectedNode) { throw ('node field must be ' + $expectedNode) }; exit 0 } catch { [Console]::Error.WriteLine('ERROR: unable to parse config JSON: ' + $env:FLEET_CONFIG_TO_VALIDATE + ' - ' + $_.Exception.Message); exit 2 }"
if errorlevel 1 exit /b 1

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "$value = Get-Content -LiteralPath $env:FLEET_CONFIG_TO_VALIDATE -Raw | ConvertFrom-Json; Write-Output ([string]$value.node)"`) do set "BATTLE_NODE=%%I"
set "RESULT_FILE=%GALAXY_DIR%\%BATTLE_NODE%.result.json"
set "SUMMARY_FILE=%GALAXY_DIR%\%BATTLE_NODE%.result.txt"
set "LOG_FILE=%GALAXY_DIR%\%BATTLE_NODE%.godot.log"

if "%COPY_RESULT%"=="1" (
  if not exist "%COPY_RESULT_TOOL%" (
    echo ERROR: result copy tool not found
    echo Expected: "%COPY_RESULT_TOOL%"
    exit /b 1
  )
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%COPY_RESULT_TOOL%" -SummaryPath "%SUMMARY_FILE%" -ConfigPath "%CONFIG_FILE%"
  if errorlevel 1 exit /b 1
  exit /b 0
)

set "FLEET_COMMON_TO_VALIDATE=%COMMON_FILE%"
powershell.exe -NoProfile -Command "try { $value = Get-Content -LiteralPath $env:FLEET_COMMON_TO_VALIDATE -Raw | ConvertFrom-Json -ErrorAction Stop; if ($null -eq $value -or $value.GetType().Name -ne 'PSCustomObject') { throw 'top-level JSON value must be an object' }; exit 0 } catch { [Console]::Error.WriteLine('ERROR: unable to parse common JSON: ' + $env:FLEET_COMMON_TO_VALIDATE + ' - ' + $_.Exception.Message); exit 2 }"
if errorlevel 1 exit /b 1

for /f "usebackq delims=" %%I in (`powershell.exe -NoProfile -Command "$value = Get-Content -LiteralPath $env:FLEET_CONFIG_TO_VALIDATE -Raw | ConvertFrom-Json; $profile = [string]$value.search.profile; if ([string]::IsNullOrWhiteSpace($profile)) { $profile = 'fast' }; $clock = [string]$value.search.simulation_clock; if ([string]::IsNullOrWhiteSpace($clock)) { if ($profile -eq 'fast' -or $profile -eq 'balanced') { $clock = 'offline_fixed_step' } else { $clock = 'realtime' } }; Write-Output $clock"`) do set "SIMULATION_CLOCK=%%I"
if /I not "%SIMULATION_CLOCK%"=="realtime" if /I not "%SIMULATION_CLOCK%"=="offline_fixed_step" (
  echo ERROR: search.simulation_clock must be realtime or offline_fixed_step
  echo Config: "%CONFIG_FILE%"
  exit /b 1
)

set "FIXED_FPS_ACTIVE=0"
if /I "%SIMULATION_CLOCK%"=="offline_fixed_step" (
  set "FIXED_FPS_ACTIVE=60"
)
set "POWERSHELL_VERBOSE_ARG="
if "%VERBOSE%"=="1" set "POWERSHELL_VERBOSE_ARG=-VerboseOutput"

if not exist "%RESULTS_DIR%\" mkdir "%RESULTS_DIR%"
copy /Y "%CONFIG_FILE%" "%GODOT_PROJECT%\config.json" >nul
if errorlevel 1 goto :stage_failed
copy /Y "%COMMON_FILE%" "%GODOT_PROJECT%\common.json" >nul
if errorlevel 1 goto :stage_failed
copy /Y "%DAILY_SETTINGS%" "%GODOT_PROJECT%\optimizer_v2_daily.json" >nul
if errorlevel 1 goto :stage_failed
for %%F in (fleet_test.gd fleet_test_runner.gd friendly_config_resolver.gd fleet_optimizer.gd fleet_optimizer_v2.gd fleet_optimizer_search.gd fleet_boss_budget.gd fleet_boss_budget_regression.gd fleet_optimizer_regression.gd fleet_grid_regression.gd fleet_quote_regression.gd optimizer_benchmark_cases.json fleet_battle_analyzer.gd fleet_optimizer_bootstrap.gd fleet_optimizer_bootstrap.tscn fleet_optimizer_battle_area.gd) do (
  copy /Y "%ROOT_DIR%\poc\%%F" "%GODOT_PROJECT%\%%F" >nul
  if errorlevel 1 goto :stage_failed
)

echo Galaxy: %GALAXY%
echo Node: %BATTLE_NODE%
echo.
echo Config: "%CONFIG_FILE%"
echo Common: "%COMMON_FILE%"
echo Optimizer config: "%DAILY_SETTINGS%" [%DAILY_SETTINGS_SOURCE%]
echo Result: "%RESULT_FILE%"
echo Summary: "%SUMMARY_FILE%"
echo Log: "%LOG_FILE%"
echo.
echo Initializing Fleet Optimizer...

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%GODOT_RUNNER%" -GodotExe "%GODOT_EXE%" -ProjectPath "%GODOT_PROJECT%" -GalaxyId "%GALAXY_ID%" -SimulationClock "%SIMULATION_CLOCK%" -FixedFpsActive %FIXED_FPS_ACTIVE% -OutputDir "%RESULTS_DIR%" -NodeResult "%RESULT_FILE%" -LogPath "%LOG_FILE%" %POWERSHELL_VERBOSE_ARG%
set "RUN_EXIT=%ERRORLEVEL%"

echo.
echo Config: "%CONFIG_FILE%"
echo Result: "%RESULT_FILE%"
echo Readable result: "%SUMMARY_FILE%"
echo Godot log: "%LOG_FILE%"
if not "%RUN_EXIT%"=="0" echo ERROR: Optimizer exited with code %RUN_EXIT%
exit /b %RUN_EXIT%

:stage_failed
echo ERROR: unable to stage optimizer files in the isolated Godot project
echo Config: "%CONFIG_FILE%"
echo Result: "%RESULT_FILE%"
echo Readable result: "%SUMMARY_FILE%"
exit /b 1
